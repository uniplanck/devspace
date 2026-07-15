import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface TodayProject {
  id: string;
  name: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

interface ProjectEvent {
  eventId: string;
  project: TodayProject;
  action: "create" | "update" | "delete";
  recordedAt: string;
}

export class NaoBrainProjectStore {
  private readonly dataDir: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  async list(includeDeleted = false): Promise<TodayProject[]> {
    await this.ensureLayout();
    const projects = await this.readState();
    return projects
      .filter((project) => includeDeleted || project.active)
      .sort((left, right) => left.name.localeCompare(right.name, "ja"));
  }

  async create(name: string): Promise<TodayProject> {
    return this.enqueue(async () => {
      await this.ensureLayout();
      const normalized = normalizeProjectName(name);
      const projects = await this.readState();
      const duplicate = projects.find((project) => project.active && project.name.toLocaleLowerCase("ja") === normalized.toLocaleLowerCase("ja"));
      if (duplicate) return duplicate;
      const now = new Date().toISOString();
      const project: TodayProject = {
        id: randomUUID(),
        name: normalized,
        active: true,
        createdAt: now,
        updatedAt: now,
      };
      projects.push(project);
      await this.persist(projects, "create", project);
      return project;
    });
  }

  async update(id: string, name: string): Promise<TodayProject> {
    return this.enqueue(async () => {
      await this.ensureLayout();
      const normalizedId = normalizeId(id);
      const normalizedName = normalizeProjectName(name);
      const projects = await this.readState();
      const index = projects.findIndex((project) => project.id === normalizedId);
      if (index < 0) throw new Error("Project was not found.");
      if (!projects[index].active) throw new Error("Deleted project cannot be edited.");
      const duplicate = projects.find((project) => project.id !== normalizedId && project.active && project.name.toLocaleLowerCase("ja") === normalizedName.toLocaleLowerCase("ja"));
      if (duplicate) throw new Error("A project with the same name already exists.");
      const project: TodayProject = {
        ...projects[index],
        name: normalizedName,
        updatedAt: new Date().toISOString(),
      };
      projects[index] = project;
      await this.persist(projects, "update", project);
      return project;
    });
  }

  async delete(id: string): Promise<TodayProject> {
    return this.enqueue(async () => {
      await this.ensureLayout();
      const normalizedId = normalizeId(id);
      const projects = await this.readState();
      const index = projects.findIndex((project) => project.id === normalizedId);
      if (index < 0) throw new Error("Project was not found.");
      const now = new Date().toISOString();
      const project: TodayProject = {
        ...projects[index],
        active: false,
        updatedAt: now,
        deletedAt: now,
      };
      projects[index] = project;
      await this.persist(projects, "delete", project);
      return project;
    });
  }

  async ensureFromNames(names: string[]): Promise<TodayProject[]> {
    const created: TodayProject[] = [];
    for (const name of names) {
      const normalized = String(name || "").trim();
      if (!normalized) continue;
      created.push(await this.create(normalized));
    }
    return created;
  }

  private async persist(projects: TodayProject[], action: ProjectEvent["action"], project: TodayProject): Promise<void> {
    const statePath = this.statePath();
    const historyPath = this.historyPath();
    await Promise.all([mkdir(dirname(statePath), { recursive: true }), mkdir(dirname(historyPath), { recursive: true })]);
    await writeFile(statePath, `${JSON.stringify(projects, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    const event: ProjectEvent = {
      eventId: randomUUID(),
      project,
      action,
      recordedAt: new Date().toISOString(),
    };
    await appendFile(historyPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  private async readState(): Promise<TodayProject[]> {
    try {
      const raw = await readFile(this.statePath(), "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isProject) : [];
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  private async ensureLayout(): Promise<void> {
    await mkdir(join(this.dataDir, "projects"), { recursive: true });
  }

  private statePath(): string {
    return join(this.dataDir, "projects", "projects.json");
  }

  private historyPath(): string {
    return join(this.dataDir, "projects", "history.jsonl");
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }
}

function normalizeProjectName(value: string): string {
  const name = String(value || "").replace(/[\u0000\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!name) throw new Error("Project name is required.");
  return name;
}

function normalizeId(value: string): string {
  const id = String(value || "").trim();
  if (!/^[0-9a-f-]{20,}$/i.test(id)) throw new Error("Invalid project id.");
  return id;
}

function isProject(value: unknown): value is TodayProject {
  if (!value || typeof value !== "object") return false;
  const project = value as Partial<TodayProject>;
  return typeof project.id === "string" && typeof project.name === "string" && typeof project.active === "boolean";
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}
