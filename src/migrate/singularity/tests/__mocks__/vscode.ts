export interface Disposable {
  dispose(): void;
}

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];

  event = (listener: (e: T) => void): Disposable => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  };

  fire(data: T): void {
    for (const listener of this.listeners) {
      listener(data);
    }
  }

  dispose(): void {
    this.listeners = [];
  }
}

export const Uri = {
  parse: (value: string) => ({
    scheme: "https",
    authority: "",
    path: value,
    fsPath: value,
    toString: () => value,
  }),
  file: (path: string) => ({
    scheme: "file",
    authority: "",
    path,
    fsPath: path,
    toString: () => path,
  }),
};

export const window = {
  createOutputChannel: (_name: string) => ({
    name: _name,
    appendLine: jest.fn(),
    append: jest.fn(),
    clear: jest.fn(),
    show: jest.fn(),
    hide: jest.fn(),
    dispose: jest.fn(),
  }),
  showErrorMessage: jest.fn().mockResolvedValue(undefined),
  showInformationMessage: jest.fn().mockResolvedValue(undefined),
  showQuickPick: jest.fn().mockResolvedValue(undefined),
  showOpenDialog: jest.fn().mockResolvedValue(undefined),
  showSaveDialog: jest.fn().mockResolvedValue(undefined),
  withProgress: jest.fn((_options, task) => task({ report: jest.fn() })),
  createStatusBarItem: jest.fn(() => ({
    show: jest.fn(),
    hide: jest.fn(),
    dispose: jest.fn(),
  })),
};

export const ProgressLocation = { Notification: 15, Window: 10, SourceControl: 1 };

export const commands = {
  registerCommand: jest.fn((_command: string, _handler: () => unknown) => ({
    dispose: jest.fn(),
  })),
  executeCommand: jest.fn().mockResolvedValue(undefined),
};

export const env = {
  openExternal: jest.fn().mockResolvedValue(true),
};

export const workspace = {
  workspaceFolders: undefined,
  getConfiguration: jest.fn(() => ({ get: jest.fn() })),
  fs: {
    stat: jest.fn().mockRejectedValue(new Error("not found")),
    writeFile: jest.fn().mockResolvedValue(undefined),
    readFile: jest.fn().mockResolvedValue(new Uint8Array()),
    rename: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  },
};

export const StatusBarAlignment = { Left: 1, Right: 2 };
export const ViewColumn = { One: 1, Two: 2, Three: 3 };

export class CancellationError extends Error {}
