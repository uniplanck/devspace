import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type TodayTagKind = "general" | "person";

export interface TodayTag {
  id: string;
  name: string;
  category: string;
  kind: TodayTagKind;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface TodayTagDraft {
  id?: string;
  name: string;
  category?: string;
  kind?: TodayTagKind;
}

interface TagEvent {
  eventId: string;
  tag: TodayTag;
  action: "create" | "update" | "delete";
  recordedAt: string;
}

export class NaoBrainTagStore {
  private readonly dataDir: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  async list(includeDeleted = false): Promise<TodayTag[]> {
    await this.ensureLayout();
    const tags = await this.readState();
    return tags
      .filter((tag) => includeDeleted || tag.active)
      .sort((left, right) => left.category.localeCompare(right.category, "ja") || left.name.localeCompare(right.name, "ja"));
  }

  async create(name: string, category?: string, kind: TodayTagKind = "general"): Promise<TodayTag> {
    return this.enqueue(async () => {
      await this.ensureLayout();
      const normalizedName = normalizeTagName(name);
      const normalizedKind = normalizeKind(kind);
      const normalizedCategory = normalizeCategory(category, normalizedKind);
      const tags = await this.readState();
      const duplicate = tags.find((tag) => tag.active && sameName(tag.name, normalizedName));
      if (duplicate) return duplicate;
      const now = new Date().toISOString();
      const tag: TodayTag = {
        id: randomUUID(),
        name: normalizedName,
        category: normalizedCategory,
        kind: normalizedKind,
        active: true,
        createdAt: now,
        updatedAt: now,
      };
      tags.push(tag);
      await this.persist(tags, "create", tag);
      return tag;
    });
  }

  async update(id: string, input: { name: string; category?: string; kind?: TodayTagKind }): Promise<TodayTag> {
    return this.enqueue(async () => {
      await this.ensureLayout();
      const normalizedId = normalizeId(id);
      const normalizedName = normalizeTagName(input.name);
      const tags = await this.readState();
      const index = tags.findIndex((tag) => tag.id === normalizedId);
      if (index < 0) throw new Error("Tag was not found.");
      if (!tags[index].active) throw new Error("Deleted tag cannot be edited.");
      const normalizedKind = input.kind === undefined ? tags[index].kind : normalizeKind(input.kind);
      const normalizedCategory = input.category === undefined
        ? tags[index].category
        : normalizeCategory(input.category, normalizedKind);
      const duplicate = tags.find((tag) => tag.id !== normalizedId && tag.active && sameName(tag.name, normalizedName));
      if (duplicate) throw new Error("A tag with the same name already exists.");
      const tag: TodayTag = {
        ...tags[index],
        name: normalizedName,
        category: normalizedCategory,
        kind: normalizedKind,
        updatedAt: new Date().toISOString(),
      };
      tags[index] = tag;
      await this.persist(tags, "update", tag);
      return tag;
    });
  }

  async delete(id: string): Promise<TodayTag> {
    return this.enqueue(async () => {
      await this.ensureLayout();
      const normalizedId = normalizeId(id);
      const tags = await this.readState();
      const index = tags.findIndex((tag) => tag.id === normalizedId);
      if (index < 0) throw new Error("Tag was not found.");
      const now = new Date().toISOString();
      const tag: TodayTag = {
        ...tags[index],
        active: false,
        updatedAt: now,
        deletedAt: now,
      };
      tags[index] = tag;
      await this.persist(tags, "delete", tag);
      return tag;
    });
  }

  async saveAll(drafts: TodayTagDraft[]): Promise<TodayTag[]> {
    return this.enqueue(async () => {
      await this.ensureLayout();
      if (!Array.isArray(drafts) || drafts.length > 500) throw new Error("Invalid tag list.");
      const normalized = drafts.map((draft) => {
        const kind = normalizeKind(draft.kind);
        return {
          id: draft.id ? String(draft.id).trim() : undefined,
          name: normalizeTagName(draft.name),
          category: normalizeCategory(draft.category, kind),
          kind,
        };
      });
      const names = new Set<string>();
      for (const draft of normalized) {
        const key = draft.name.toLocaleLowerCase("ja");
        if (names.has(key)) throw new Error(`Duplicate tag name: ${draft.name}`);
        names.add(key);
      }

      const tags = await this.readState();
      const currentById = new Map(tags.map((tag) => [tag.id, tag]));
      const submittedIds = new Set(normalized.map((draft) => draft.id).filter(Boolean));
      const now = new Date().toISOString();
      const events: TagEvent[] = [];

      for (let index = 0; index < tags.length; index += 1) {
        const current = tags[index];
        if (current.active && !submittedIds.has(current.id)) {
          const deleted = { ...current, active: false, updatedAt: now, deletedAt: now };
          tags[index] = deleted;
          events.push({ eventId: randomUUID(), tag: deleted, action: "delete", recordedAt: now });
        }
      }

      for (const draft of normalized) {
        const current = draft.id ? currentById.get(draft.id) : undefined;
        if (current?.active) {
          const next: TodayTag = {
            ...current,
            name: draft.name,
            category: draft.category,
            kind: draft.kind,
            updatedAt: now,
          };
          const index = tags.findIndex((tag) => tag.id === current.id);
          tags[index] = next;
          if (current.name !== next.name || current.category !== next.category || current.kind !== next.kind) {
            events.push({ eventId: randomUUID(), tag: next, action: "update", recordedAt: now });
          }
          continue;
        }
        const created: TodayTag = {
          id: randomUUID(),
          name: draft.name,
          category: draft.category,
          kind: draft.kind,
          active: true,
          createdAt: now,
          updatedAt: now,
        };
        tags.push(created);
        events.push({ eventId: randomUUID(), tag: created, action: "create", recordedAt: now });
      }

      await this.persistMany(tags, events);
      return tags
        .filter((tag) => tag.active)
        .sort((left, right) => left.category.localeCompare(right.category, "ja") || left.name.localeCompare(right.name, "ja"));
    });
  }

  async ensureFromNames(names: string[]): Promise<TodayTag[]> {
    const created: TodayTag[] = [];
    for (const name of Array.from(new Set(names.map((value) => String(value || "").trim()).filter(Boolean)))) {
      created.push(await this.create(name, "未分類", "general"));
    }
    return created;
  }

  private async persist(tags: TodayTag[], action: TagEvent["action"], tag: TodayTag): Promise<void> {
    const statePath = this.statePath();
    const historyPath = this.historyPath();
    await Promise.all([mkdir(dirname(statePath), { recursive: true }), mkdir(dirname(historyPath), { recursive: true })]);
    await writeFile(statePath, `${JSON.stringify(tags, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    const event: TagEvent = { eventId: randomUUID(), tag, action, recordedAt: new Date().toISOString() };
    await appendFile(historyPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  private async persistMany(tags: TodayTag[], events: TagEvent[]): Promise<void> {
    const statePath = this.statePath();
    const historyPath = this.historyPath();
    await Promise.all([mkdir(dirname(statePath), { recursive: true }), mkdir(dirname(historyPath), { recursive: true })]);
    await writeFile(statePath, `${JSON.stringify(tags, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    if (events.length) {
      await appendFile(historyPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
    }
  }

  private async readState(): Promise<TodayTag[]> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath(), "utf8"));
      return Array.isArray(parsed) ? parsed.filter(isTag) : [];
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  private async ensureLayout(): Promise<void> {
    await mkdir(join(this.dataDir, "tags"), { recursive: true });
  }

  private statePath(): string {
    return join(this.dataDir, "tags", "tags.json");
  }

  private historyPath(): string {
    return join(this.dataDir, "tags", "history.jsonl");
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }
}

function normalizeTagName(value: string): string {
  const name = String(value || "").replace(/[\u0000\r\n#,]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  if (!name) throw new Error("Tag name is required.");
  return name;
}

function normalizeCategory(value: unknown, kind: TodayTagKind): string {
  const category = String(value || "").replace(/[\u0000\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  return category || (kind === "person" ? "人" : "未分類");
}

function normalizeKind(value: unknown): TodayTagKind {
  return value === "person" ? "person" : "general";
}

function normalizeId(value: string): string {
  const id = String(value || "").trim();
  if (!/^[0-9a-f-]{20,}$/i.test(id)) throw new Error("Invalid tag id.");
  return id;
}

function sameName(left: string, right: string): boolean {
  return left.toLocaleLowerCase("ja") === right.toLocaleLowerCase("ja");
}

function isTag(value: unknown): value is TodayTag {
  if (!value || typeof value !== "object") return false;
  const tag = value as Partial<TodayTag>;
  return typeof tag.id === "string"
    && typeof tag.name === "string"
    && typeof tag.category === "string"
    && (tag.kind === "general" || tag.kind === "person")
    && typeof tag.active === "boolean";
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}
