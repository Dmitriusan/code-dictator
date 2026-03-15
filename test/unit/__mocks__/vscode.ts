/**
 * Minimal vscode module mock for unit tests.
 * Only stubs the APIs actually used by the source modules under test.
 */
import { vi } from 'vitest';

// ── Status bar items ──
export function createMockStatusBarItem() {
  return {
    text: '',
    tooltip: '',
    command: undefined as string | undefined,
    name: undefined as string | undefined,
    backgroundColor: undefined as unknown,
    color: undefined as unknown,
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  };
}

// ── Workspace configuration ──
export function createMockConfiguration(values: Record<string, unknown> = {}) {
  return {
    get: vi.fn(<T>(key: string, defaultValue?: T): T => {
      return (key in values ? values[key] : defaultValue) as T;
    }),
    update: vi.fn().mockResolvedValue(undefined),
    has: vi.fn((key: string) => key in values),
    inspect: vi.fn(),
  };
}

// ── Extension context ──
export function createMockExtensionContext() {
  const secretStore = new Map<string, string>();
  const globalStateStore = new Map<string, unknown>();

  return {
    secrets: {
      get: vi.fn(async (key: string) => secretStore.get(key)),
      store: vi.fn(async (key: string, value: string) => { secretStore.set(key, value); }),
      delete: vi.fn(async (key: string) => { secretStore.delete(key); }),
      onDidChange: vi.fn(),
    },
    globalState: {
      get: vi.fn(<T>(key: string, defaultValue?: T): T => {
        return (globalStateStore.has(key) ? globalStateStore.get(key) : defaultValue) as T;
      }),
      update: vi.fn(async (key: string, value: unknown) => { globalStateStore.set(key, value); }),
      keys: vi.fn(() => [...globalStateStore.keys()]),
      setKeysForSync: vi.fn(),
    },
    subscriptions: [] as { dispose(): void }[],
    extensionUri: { fsPath: '/mock/extension' },
    _secretStore: secretStore,
    _globalStateStore: globalStateStore,
  };
}

// ── The mock module ──
const vscode = {
  window: {
    createStatusBarItem: vi.fn(() => createMockStatusBarItem()),
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showOpenDialog: vi.fn(),
    setStatusBarMessage: vi.fn(),
    activeTextEditor: undefined as unknown,
    createOutputChannel: vi.fn(() => ({
      appendLine: vi.fn(),
      append: vi.fn(),
      clear: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
    })),
  },
  workspace: {
    getConfiguration: vi.fn(() => createMockConfiguration()),
    onDidChangeConfiguration: vi.fn(),
  },
  commands: {
    executeCommand: vi.fn(),
    registerCommand: vi.fn(),
    getCommands: vi.fn().mockResolvedValue([]),
  },
  env: {
    clipboard: {
      writeText: vi.fn().mockResolvedValue(undefined),
      readText: vi.fn().mockResolvedValue(''),
    },
    openExternal: vi.fn().mockResolvedValue(true),
  },
  Uri: {
    parse: vi.fn((s: string) => ({ toString: () => s, fsPath: s })),
    file: vi.fn((s: string) => ({ toString: () => s, fsPath: s })),
  },
  StatusBarAlignment: {
    Left: 1,
    Right: 2,
  },
  ThemeColor: vi.fn(function (this: { id: string }, id: string) {
    this.id = id;
  }),
  ConfigurationTarget: {
    Global: 1,
    Workspace: 2,
    WorkspaceFolder: 3,
  },
  QuickPickItemKind: {
    Separator: -1,
    Default: 0,
  },
  Disposable: vi.fn(function (this: { dispose: () => void }, callOnDispose: () => void) {
    this.dispose = callOnDispose;
  }),
};

export default vscode;
