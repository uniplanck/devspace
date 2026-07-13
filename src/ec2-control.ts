import { execFile } from "node:child_process";

export type Ec2ControlAction =
  | "status"
  | "ec2_start"
  | "ec2_stop"
  | "schedule_create"
  | "schedule_delete"
  | "billing_refresh";

export interface Ec2ControlInput {
  action: Ec2ControlAction;
  scheduleAction?: "ec2_start" | "ec2_stop";
  scheduleType?: "once" | "daily";
  runAt?: string;
  dailyTime?: string;
  scheduleName?: string;
}

export interface Ec2ControlResponse extends Record<string, unknown> {
  ok: boolean;
  action?: string;
  message?: string;
  error?: string;
  code?: string;
  ec2?: {
    state?: string;
    runtime_seconds?: number | null;
  };
  minecraft?: {
    state?: string;
    online_count?: number;
  };
  billing?: {
    status?: string;
    remaining_credits?: number;
    currency?: string;
    expires_at?: string;
    estimated_operating_days?: number;
    average_daily_ec2_cost?: number;
    limiting_factor?: string;
    updated_at_jst?: string;
    stale?: boolean;
  };
  schedules?: {
    status?: string;
    configured?: boolean;
    items?: Array<{
      name?: string;
      action?: string;
      type?: string;
      value?: string;
      next_run_jst?: string;
      state?: string;
    }>;
  };
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: {
    timeout: number;
    env: NodeJS.ProcessEnv;
  },
) => Promise<CommandResult>;

const DEFAULT_REGION = "ap-northeast-3";
const DEFAULT_FUNCTION_NAME = "minecraft-start-button";

function runCommand(
  command: string,
  args: string[],
  options: { timeout: number; env: NodeJS.ProcessEnv },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: options.timeout,
        env: options.env,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || error.message || "AWS CLI failed").trim();
          reject(new Error(detail.slice(0, 600)));
          return;
        }
        resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
      },
    );
  });
}

function requirePattern(value: string | undefined, pattern: RegExp, message: string): string {
  const normalized = String(value || "").trim();
  if (!pattern.test(normalized)) throw new Error(message);
  return normalized;
}

export function buildEc2ControlPayload(input: Ec2ControlInput): Record<string, string> {
  const payload: Record<string, string> = {
    control_api: "1",
    control_action: input.action,
  };

  if (input.action === "schedule_create") {
    if (!input.scheduleAction || !["ec2_start", "ec2_stop"].includes(input.scheduleAction)) {
      throw new Error("scheduleAction must be ec2_start or ec2_stop");
    }
    if (!input.scheduleType || !["once", "daily"].includes(input.scheduleType)) {
      throw new Error("scheduleType must be once or daily");
    }
    payload.schedule_action = input.scheduleAction;
    payload.schedule_type = input.scheduleType;
    if (input.scheduleType === "once") {
      payload.run_at = requirePattern(
        input.runAt,
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/,
        "runAt must use YYYY-MM-DDTHH:mm in Asia/Tokyo",
      );
    } else {
      payload.daily_time = requirePattern(
        input.dailyTime,
        /^([01]\d|2[0-3]):[0-5]\d$/,
        "dailyTime must use HH:mm in Asia/Tokyo",
      );
    }
  }

  if (input.action === "schedule_delete") {
    payload.schedule_name = requirePattern(
      input.scheduleName,
      /^uniplanck-ec2-[a-z0-9-]{1,50}$/,
      "scheduleName is invalid",
    );
  }

  return payload;
}

export type HttpFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

async function resolveControlConnection(
  runner: CommandRunner,
): Promise<{ url: string; token: string }> {
  const region = process.env.DEVSPACE_EC2_CONTROL_REGION || DEFAULT_REGION;
  const functionName = process.env.DEVSPACE_EC2_CONTROL_FUNCTION || DEFAULT_FUNCTION_NAME;
  const command = process.env.AWS_CLI_COMMAND || "aws";
  const env = { ...process.env, AWS_PAGER: "" };

  let url = String(process.env.DEVSPACE_EC2_CONTROL_URL || "").trim();
  if (!url) {
    const result = await runner(
      command,
      [
        "lambda",
        "get-function-url-config",
        "--region",
        region,
        "--function-name",
        functionName,
        "--query",
        "FunctionUrl",
        "--output",
        "text",
        "--no-cli-pager",
      ],
      { timeout: 15_000, env },
    );
    url = result.stdout.trim();
  }

  let token = String(process.env.DEVSPACE_EC2_CONTROL_PROXY_TOKEN || "").trim();
  if (!token) {
    const result = await runner(
      command,
      [
        "lambda",
        "get-function-configuration",
        "--region",
        region,
        "--function-name",
        functionName,
        "--query",
        "Environment.Variables.MINECRAFT_CONTROL_PROXY_TOKEN",
        "--output",
        "text",
        "--no-cli-pager",
      ],
      { timeout: 15_000, env },
    );
    token = result.stdout.trim();
  }

  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "https:" || !parsedUrl.hostname.endsWith(".lambda-url.ap-northeast-3.on.aws")) {
    throw new Error("EC2 control Function URL is invalid");
  }
  if (token.length < 32 || token === "None") {
    throw new Error("EC2 control proxy token is unavailable");
  }
  return { url: parsedUrl.toString(), token };
}

export async function invokeEc2Control(
  input: Ec2ControlInput,
  runner: CommandRunner = runCommand,
  fetcher: HttpFetcher = fetch,
): Promise<Ec2ControlResponse> {
  const connection = await resolveControlConnection(runner);
  const target = new URL(connection.url);
  for (const [key, value] of Object.entries(buildEc2ControlPayload(input))) {
    target.searchParams.set(key, value);
  }

  const response = await fetcher(target, {
    method: "GET",
    headers: {
      accept: "application/json",
      "x-control-proxy-token": connection.token,
    },
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({})) as Ec2ControlResponse;
  if (!response.ok || !payload.ok) {
    const message = String(payload.error || `EC2 control failed (${response.status})`);
    const code = payload.code ? ` [${String(payload.code)}]` : "";
    throw new Error(`${message}${code}`);
  }
  return payload;
}

function formatMoney(value: unknown, currency = "USD"): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "取得不可";
  return new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatDuration(seconds: unknown): string {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return "-";
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  return hours > 0 ? `${hours}時間${minutes}分` : `${minutes}分`;
}

export function formatEc2ControlSummary(response: Ec2ControlResponse): string {
  const lines: string[] = [];
  if (response.message) lines.push(String(response.message));

  const ec2State = String(response.ec2?.state || "unknown");
  lines.push(`EC2: ${ec2State}（稼働 ${formatDuration(response.ec2?.runtime_seconds)}）`);
  lines.push(`GAE: ${ec2State === "running" ? "稼働構成" : "EC2停止中"}`);
  lines.push(
    `Minecraft: ${String(response.minecraft?.state || "unknown")}（接続 ${Number(response.minecraft?.online_count || 0)}人）`,
  );

  const billing = response.billing;
  if (billing?.status === "ok") {
    lines.push(
      `AWSクレジット: ${formatMoney(billing.remaining_credits, billing.currency || "USD")} / 予測稼働 ${Number.isFinite(Number(billing.estimated_operating_days)) ? `約${Number(billing.estimated_operating_days).toFixed(1)}日` : "算出不可"}`,
    );
    lines.push(
      `EC2関連費用: ${formatMoney(billing.average_daily_ec2_cost, billing.currency || "USD")}/日（${billing.stale ? "前回取得値" : "AWS取得値"}）`,
    );
  } else {
    lines.push("AWSクレジット: 取得不可");
  }

  const schedules = response.schedules?.items || [];
  lines.push(`EC2予約: ${schedules.length}件`);
  for (const item of schedules.slice(0, 5)) {
    const action = item.action === "ec2_start" ? "起動" : item.action === "ec2_stop" ? "停止" : item.action || "不明";
    const cadence = item.type === "daily" ? `毎日 ${item.value || "-"}` : item.next_run_jst || item.value || "-";
    lines.push(`- ${action}: ${cadence}`);
  }

  return lines.join("\n");
}
