import { Hono, type Context } from "hono";
import type { Env } from "./index";
import {
  ObsidianConflictError,
  ObsidianPathError,
  type ObsidianVault,
} from "./obsidian";

export const obsidianRoutes = new Hono<{ Bindings: Env }>();

function configured(env: Env): ObsidianVault | null {
  return env.OBSIDIAN ?? null;
}

function safeNoteName(value: string): string {
  const cleaned = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f/\\:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^\.+|\.+$/g, "")
    .trim()
    .slice(0, 80);
  return cleaned || "제목 없음";
}

function localDay(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function obsidianError(c: Context<{ Bindings: Env }>, error: unknown) {
  if (error instanceof ObsidianConflictError) return c.json({ error: error.message }, 409);
  if (error instanceof ObsidianPathError) return c.json({ error: error.message }, 400);
  console.error("[Obsidian 연동]", error);
  return c.json({ error: "Obsidian 연동 처리에 실패했습니다" }, 500);
}

obsidianRoutes.get("/obsidian/status", (c) => {
  const vault = configured(c.env);
  if (!vault) {
    return c.json({
      status: c.env.OBSIDIAN_ERROR ? "unavailable" : "unconfigured",
      vaultName: null,
      canRead: false,
      canWrite: false,
      mode: "disabled",
    });
  }
  const status = vault.status();
  const canWrite = status.canWrite && c.env.OBSIDIAN_WRITE_ENABLED === true;
  return c.json({
    status: status.canRead ? "ready" : "unavailable",
    vaultName: status.vaultName,
    canRead: status.canRead,
    canWrite,
    mode: canWrite ? "read-write" : "read-only",
  });
});

async function exportContext(env: Env, subjectId: string) {
  const subject = await env.DB.prepare("SELECT name FROM subjects WHERE id = ?")
    .bind(subjectId).first<{ name: string }>();
  if (!subject) return null;
  const note = await env.DB.prepare("SELECT content, status, updated_at FROM notes WHERE subject_id = ?")
    .bind(subjectId).first<{ content: string; status: string; updated_at: string }>();
  if (!note?.content.trim()) return { subject, note: null };
  return { subject, note };
}

obsidianRoutes.post("/subjects/:id/obsidian/export/preview", async (c) => {
  const vault = configured(c.env);
  if (!vault) return c.json({ error: "Obsidian 볼트가 설정되지 않았습니다" }, 503);
  const body = await c.req.json<{ path?: string }>().catch(() => ({}) as { path?: string });
  const context = await exportContext(c.env, c.req.param("id"));
  if (!context) return c.json({ error: "subject not found" }, 404);
  if (!context.note) return c.json({ error: "내보낼 노트가 없습니다" }, 404);
  const path = body.path?.trim() || `REMAP - ${safeNoteName(context.subject.name)} - ${localDay()}.md`;
  try {
    return c.json({
      path,
      exists: vault.targetExists(path),
      canWrite: c.env.OBSIDIAN_WRITE_ENABLED === true && vault.status().canWrite,
    });
  } catch (error) {
    return obsidianError(c, error);
  }
});

obsidianRoutes.post("/subjects/:id/obsidian/export", async (c) => {
  const vault = configured(c.env);
  if (!vault) return c.json({ error: "Obsidian 볼트가 설정되지 않았습니다" }, 503);
  if (c.env.OBSIDIAN_WRITE_ENABLED !== true || !vault.status().canWrite) {
    return c.json({ error: "Obsidian 연동이 읽기 전용입니다" }, 403);
  }
  const body = await c.req.json<{ path?: string }>().catch(() => ({}) as { path?: string });
  const context = await exportContext(c.env, c.req.param("id"));
  if (!context) return c.json({ error: "subject not found" }, 404);
  if (!context.note) return c.json({ error: "내보낼 노트가 없습니다" }, 404);
  if (context.note.status !== "ready") return c.json({ error: "완료된 노트만 내보낼 수 있습니다" }, 409);
  const path = body.path?.trim() || `REMAP - ${safeNoteName(context.subject.name)} - ${localDay()}.md`;
  try {
    const result = vault.writeMarkdown(path, context.note.content, {
      type: "studywork-note",
      tags: ["studywork", "notes"],
      updated: localDay(),
      up: ["[[StudyWork — Personal Study Assistant]]"],
      source: `REMAP subject ${c.req.param("id")}`,
    });
    return c.json(result, 201);
  } catch (error) {
    return obsidianError(c, error);
  }
});
