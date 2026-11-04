export interface ListedFile {
  /** Path relative to the listed directory, with '/' separators. */
  path: string;
  /** Absolute path of the file. */
  file: string;
}
export function listFiles(dir: string): ListedFile[];
export function contentDigestLines(dir: string): string[];
export function contentDigest(dir: string): string;
