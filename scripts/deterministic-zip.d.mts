export interface ZipEntry {
  path: string;
  data: Uint8Array;
}
export interface PackResult {
  files: number;
  bytes: number;
  sha256: string;
  /** The time the archive's entries carry: zipEntryDate of the date packed with. */
  entryDate: Date;
}
export type SourceDateOrigin = 'SOURCE_DATE_EPOCH' | 'commit' | 'none';
export const EARLIEST_ZIP_DATE: Date;
export const LATEST_ZIP_DATE: Date;
export function crc32(data: Uint8Array): number;
export function zipEntryDate(date: Date): Date;
export function dosDateTime(date: Date): { time: number; date: number };
export function zipFiles(entries: ZipEntry[], date: Date): Uint8Array;
export function sourceDate(
  root: string,
  env?: Record<string, string | undefined>,
): { date: Date; source: SourceDateOrigin };
export function packDirectory(dir: string, outFile: string, date: Date): PackResult;
