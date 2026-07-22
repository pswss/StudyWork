import { Hono } from "hono";
import type { Env } from "./index";
import { chat as aiChat, capMaterialExcerpts } from "./claude";
import { checkAndIncrementUsage } from "./usage";
import { cancelJob, finishJob, isCurrentJob, startJob } from "./jobs";

export const chatRoutes = new Hono<{ Bindings: Env }>();

chatRoutes.get("/subjects/:id/messages", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, role, content, mode, created_at FROM messages WHERE subject_id = ? ORDER BY id"
  ).bind(c.req.param("id")).all();
  return c.json(results);
});

chatRoutes.post("/subjects/:id/chat", async (c) => {
  const subjectId = c.req.param("id");
  const { message, mode, materialIds } = await c.req
    .json<{ message?: string; mode?: string; materialIds?: unknown }>()
    .catch(() => ({}) as any);
  if (!message?.trim()) return c.json({ error: "message required" }, 400);
  const general = mode === "general";

  // materialIds가 오면(자료 기반 모드) 그 목록만 컨텍스트로 사용, 생략하면 전체
  if (!general && materialIds !== undefined) {
    if (
      !Array.isArray(materialIds) ||
      materialIds.length < 1 ||
      materialIds.length > 500 ||
      materialIds.some((id) => !Number.isSafeInteger(id) || (id as number) < 1) ||
      new Set(materialIds).size !== materialIds.length
    ) {
      return c.json({ error: "materialIds는 중복 없는 1~500개의 양의 정수 ID여야 합니다" }, 400);
    }
  }

  const subject = await c.env.DB.prepare("SELECT name FROM subjects WHERE id = ?")
    .bind(subjectId).first<{ name: string }>();
  if (!subject) return c.json({ error: "subject not found" }, 404);

  // 일반 질문 모드에서는 자료 컨텍스트를 주입하지 않는다
  const { results: allMats } = general
    ? { results: [] as { id: number; title: string; extracted_text: string }[] }
    : await c.env.DB.prepare(
        "SELECT id, title, extracted_text FROM materials WHERE subject_id = ? AND status = 'ready' ORDER BY created_at"
      ).bind(subjectId).all<{ id: number; title: string; extracted_text: string }>();
  const selected = !general && Array.isArray(materialIds) ? new Set(materialIds as number[]) : null;
  const mats = selected ? allMats.filter((material) => selected.has(material.id)) : allMats;
  if (selected && mats.length !== selected.size) {
    return c.json({ error: "선택한 자료 중 이 과목에서 사용할 수 없는 파일이 있습니다" }, 400);
  }

  // 자료 기반 모드인데 자료가 하나도 없으면 AI를 호출하지 않고 안내만 반환 (사용량 미소모)
  if (!general && mats.length === 0) {
    const reply =
      "아직 이 과목에 업로드된 자료가 없어요. 자료 기반 모드는 올려주신 자료만 근거로 답하기 때문에, " +
      "먼저 자료를 업로드해 주시거나 '일반 질문' 모드로 바꿔서 질문해 주세요!";
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO messages (subject_id, role, content, mode) VALUES (?, 'user', ?, ?)")
        .bind(subjectId, message.trim(), "materials"),
      c.env.DB.prepare("INSERT INTO messages (subject_id, role, content, mode) VALUES (?, 'assistant', ?, ?)")
        .bind(subjectId, reply, "materials"),
    ]);
    return c.json({ reply });
  }

  if (!(await checkAndIncrementUsage(c.env.DB))) {
    return c.json({ error: "오늘 사용량 한도 도달" }, 429);
  }

  const { results: hist } = await c.env.DB.prepare(
    "SELECT role, content FROM (SELECT id, role, content FROM messages WHERE subject_id = ? ORDER BY id DESC LIMIT 30) ORDER BY id"
  ).bind(subjectId).all<{ role: "user" | "assistant"; content: string }>();
  hist.push({ role: "user", content: message.trim() });

  const job = startJob(`chat:${subjectId}`);
  try {
    // provider/model/reasoning은 서버 환경 설정만 사용한다. 요청 본문으로 덮어쓰지 않는다.
    // 자료 본문은 퀴즈 생성과 같은 96k 예산으로 자료별 균등 발췌 — 매 메시지 전체 주입 방지.
    const context = capMaterialExcerpts(mats).map(({ title, extracted_text }) => ({ title, extracted_text }));
    const reply = await aiChat(subject.name, context, hist, general, job.signal);
    if (!isCurrentJob(job)) throw new Error("사용자 중단");
    // AI 성공 후에만 user+assistant 메시지 저장 (실패 시 유령 user 메시지 방지)
    const msgMode = general ? "general" : "materials";
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO messages (subject_id, role, content, mode) VALUES (?, 'user', ?, ?)")
        .bind(subjectId, message.trim(), msgMode),
      c.env.DB.prepare("INSERT INTO messages (subject_id, role, content, mode) VALUES (?, 'assistant', ?, ?)")
        .bind(subjectId, reply, msgMode),
    ]);
    return c.json({ reply });
  } catch (e) {
    return c.json({ error: `AI 응답 실패: ${String(e)}` }, 502);
  } finally {
    finishJob(job);
  }
});

chatRoutes.post("/subjects/:id/chat/cancel", (c) => {
  cancelJob(`chat:${c.req.param("id")}`);
  return c.json({ status: "cancelled" });
});
