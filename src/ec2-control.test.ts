import assert from "node:assert/strict";
import {
  buildEc2ControlPayload,
  formatEc2ControlSummary,
  invokeEc2Control,
  type CommandRunner,
  type HttpFetcher,
} from "./ec2-control.js";

const once = buildEc2ControlPayload({
  action: "schedule_create",
  scheduleAction: "ec2_start",
  scheduleType: "once",
  runAt: "2026-07-14T09:30",
});
assert.deepEqual(once, {
  control_api: "1",
  control_action: "schedule_create",
  schedule_action: "ec2_start",
  schedule_type: "once",
  run_at: "2026-07-14T09:30",
});

const daily = buildEc2ControlPayload({
  action: "schedule_create",
  scheduleAction: "ec2_stop",
  scheduleType: "daily",
  dailyTime: "23:15",
});
assert.equal(daily.daily_time, "23:15");

assert.throws(
  () => buildEc2ControlPayload({
    action: "schedule_create",
    scheduleAction: "ec2_start",
    scheduleType: "daily",
    dailyTime: "25:00",
  }),
  /dailyTime/,
);

assert.throws(
  () => buildEc2ControlPayload({
    action: "schedule_delete",
    scheduleName: "other-schedule",
  }),
  /scheduleName/,
);

const runner: CommandRunner = async (_command, args) => {
  if (args.includes("get-function-url-config")) {
    return { stdout: "https://example.lambda-url.ap-northeast-3.on.aws/\n", stderr: "" };
  }
  if (args.includes("get-function-configuration")) {
    return { stdout: `${"x".repeat(32)}\n`, stderr: "" };
  }
  throw new Error(`Unexpected AWS command: ${args.join(" ")}`);
};

const fetcher: HttpFetcher = async (input, init) => {
  const url = new URL(String(input));
  assert.equal(url.searchParams.get("control_api"), "1");
  assert.equal(url.searchParams.get("control_action"), "status");
  assert.equal((init?.headers as Record<string, string>)["x-control-proxy-token"], "x".repeat(32));
  return new Response(JSON.stringify({
    ok: true,
    action: "status",
    ec2: { state: "running", runtime_seconds: 3600 },
    minecraft: { state: "stopped", online_count: 0 },
    billing: {
      status: "ok",
      remaining_credits: 180.24,
      currency: "USD",
      estimated_operating_days: 130.5,
      average_daily_ec2_cost: 1.25,
      stale: false,
    },
    schedules: {
      status: "ok",
      configured: true,
      items: [{
        name: "uniplanck-ec2-stop-test",
        action: "ec2_stop",
        type: "daily",
        value: "23:00",
        next_run_jst: "2026/07/13 23:00",
        state: "ENABLED",
      }],
    },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

const response = await invokeEc2Control({ action: "status" }, runner, fetcher);
assert.equal(response.ec2?.state, "running");
const summary = formatEc2ControlSummary(response);
assert.match(summary, /AWSクレジット/);
assert.match(summary, /180\.24/);
assert.match(summary, /EC2予約: 1件/);
assert.match(summary, /毎日 23:00/);

console.log("ec2-control tests passed");
