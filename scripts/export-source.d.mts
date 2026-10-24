export const ROOT_FILES: readonly string[];
export const SOURCE_DIRECTORIES: readonly string[];
export function auditContent(relative: string, content: Buffer): void;
export function exportSources(sourceRoot: string, destination: string): Promise<{ directory: string; files: number; bytes: number }>;
