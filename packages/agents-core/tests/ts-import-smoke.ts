import { create } from "@bufbuild/protobuf";
import { name as sharedName } from "@agentos/shared-ts";
import { name as tuiName } from "@agentos/tui";
import { name as webName } from "@agentos/web";
import {
  ListModelsRequestSchema,
  RegistryService,
  file_rommie_v1_common,
} from "@agentos/shared-ts/gen";

const request = create(ListModelsRequestSchema, {});

if (
  sharedName !== "@agentos/shared-ts" ||
  tuiName !== "@agentos/tui" ||
  webName !== "@agentos/web" ||
  request.$typeName !== "rommie.v1.ListModelsRequest" ||
  file_rommie_v1_common.name !== "rommie/v1/common.proto" ||
  RegistryService.typeName !== "rommie.v1.RegistryService"
) {
  throw new Error("agents-core TypeScript import smoke test failed");
}
