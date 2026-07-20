import { createEmptyProject } from "../../src/shared/bundle.js";
import { projectJsonSchema } from "../../src/shared/schemas.js";

describe("schemas", () => {
  test("valid empty project passes validation", () => {
    const project = createEmptyProject("Valid", 48000);
    const result = projectJsonSchema.safeParse(project);
    expect(result.success).toBe(true);
  });

  test("missing $schema fails validation", () => {
    const project = createEmptyProject("Invalid", 48000) as Record<string, unknown>;
    project.$schema = undefined;
    const result = projectJsonSchema.safeParse(project);
    expect(result.success).toBe(false);
  });

  test("invalid timeSignature fails validation", () => {
    const project = createEmptyProject("Invalid", 48000);
    project.project.timeSignature = [0, 4] as [number, number];
    const result = projectJsonSchema.safeParse(project);
    expect(result.success).toBe(false);
  });

  test("invalid track color fails validation", () => {
    const project = createEmptyProject("Invalid", 48000);
    project.tracks[0].color = "blue";
    const result = projectJsonSchema.safeParse(project);
    expect(result.success).toBe(false);
  });

  test("pan outside range fails validation", () => {
    const project = createEmptyProject("Invalid", 48000);
    project.tracks[0].pan = 2;
    const result = projectJsonSchema.safeParse(project);
    expect(result.success).toBe(false);
  });
});
