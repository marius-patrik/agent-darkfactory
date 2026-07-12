import { create } from "@bufbuild/protobuf";
import { name as sharedName } from "@agent-os/shared-ts";
import { name as tuiName } from "@agent-os/tui";
import { name as webName } from "@agent-os/web";
import {
  ListModelsRequestSchema,
  RegistryService,
  file_agent_os_v1_common,
} from "@agent-os/shared-ts/gen";

const request = create(ListModelsRequestSchema, {});

if (
  sharedName !== "@agent-os/shared-ts" ||
  tuiName !== "@agent-os/tui" ||
  webName !== "@agent-os/web" ||
  request.$typeName !== "agent_os.v1.ListModelsRequest" ||
  file_agent_os_v1_common.name !== "agent_os/v1/common" ||
  RegistryService.typeName !== "agent_os.v1.RegistryService"
) {
  throw new Error("Agent OS core TypeScript import smoke test failed");
}
