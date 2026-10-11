export function enableDeveloperMode(
  launcher: { launch: (options: Record<string, unknown>) => Promise<unknown> },
  profile: { userDataDir: string; executablePath?: string },
): Promise<void>;
