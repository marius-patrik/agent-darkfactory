import { z } from "zod";

export const timeSignatureSchema = z.tuple([
  z.number().int().positive(),
  z.number().int().positive(),
]);

export const loopSchema = z.object({
  enabled: z.boolean(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});

export const projectMetadataSchema = z.object({
  name: z.string().min(1),
  sampleRate: z.number().int().positive(),
  tempo: z.number().positive(),
  timeSignature: timeSignatureSchema,
  loop: loopSchema,
});

export const trackSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  type: z.enum(["audio", "midi", "bus", "master"]),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  volumeDb: z.number(),
  pan: z.number().min(-1).max(1),
  mute: z.boolean(),
  solo: z.boolean(),
  arm: z.boolean(),
  inserts: z.array(z.unknown()),
});

const audioFilePathRegex = /^audio\/[\w\-. ]+\.\w+$/i;

export const regionSchema = z.object({
  id: z.string().min(1),
  trackId: z.string().min(1),
  audioFile: z.string().regex(audioFilePathRegex).optional(),
  start: z.number().int(),
  duration: z.number().int().positive(),
  offset: z.number().int().default(0),
  fadeIn: z
    .object({ type: z.string(), duration: z.number().nonnegative() })
    .default({ type: "linear", duration: 0 }),
  fadeOut: z
    .object({ type: z.string(), duration: z.number().nonnegative() })
    .default({ type: "linear", duration: 0 }),
});

export const projectJsonSchema = z.object({
  $schema: z.literal("vsdaw://project.json/v1"),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  createdBy: z.literal("vsdaw"),
  createdAt: z.string().datetime(),
  project: projectMetadataSchema,
  tracks: z.array(trackSchema),
  regions: z.array(regionSchema),
  midiClips: z.array(z.unknown()),
  automation: z.array(z.unknown()),
  mixer: z.object({ masterVolumeDb: z.number() }),
});

export type ProjectJson = z.infer<typeof projectJsonSchema>;
export type ProjectMetadata = z.infer<typeof projectMetadataSchema>;
export type Track = z.infer<typeof trackSchema>;
export type Region = z.infer<typeof regionSchema>;
