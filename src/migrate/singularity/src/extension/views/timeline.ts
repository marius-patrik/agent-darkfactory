import type * as vscode from "vscode";
import { VsdawDocument, VsdawEditorProvider } from "../editor/vsdawEditor.js";
import type { ProjectManager } from "../projectManager.js";

export class TimelineCustomEditorProvider extends VsdawEditorProvider {
  public static override readonly viewType = "vsdaw.editor";
}

export { VsdawDocument };
