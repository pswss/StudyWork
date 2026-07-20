import { Hono } from "hono";
import type { Env } from "./index";
import { getStudySkillRegistry } from "./skills";

export const skillRoutes = new Hono<{ Bindings: Env }>();

skillRoutes.get("/skills", (c) => {
  const registry = getStudySkillRegistry();
  const skills = registry.list();
  return c.json({
    mode: "instructions-only",
    discovered: skills.length,
    enabled: skills.filter((skill) => skill.enabled).length,
    loadErrors: registry.errorCount(),
    skills,
  });
});
