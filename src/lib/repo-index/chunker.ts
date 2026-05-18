// Line-based chunking for the candidate-OSS indexer.
//
// Splits source files into adjacent-line groups capped at a desired byte
// length. The goal isn't perfect semantic chunks — that needs an AST and
// per-language tree-sitter parsers, which is a v2 upgrade. The goal is
// chunks small enough that BM25 ranking is meaningful (a whole file as
// one chunk dilutes term frequencies) and large enough that returned hits
// give the LLM real context (a single line is useless).
//
// Why line-based and not byte-window: line boundaries respect human-readable
// structure. A 1500-byte sliding window would cut in the middle of a function
// signature and pollute the chunk with a half-statement; line-based stops
// at the line break before exceeding the budget, so chunks contain whole
// statements even without an AST.

export const DESIRED_CHUNK_BYTES = 1500;

export type Chunk = {
  filePath: string;
  startLine: number; // 1-indexed
  endLine: number;   // 1-indexed, inclusive
  language: string | null;
  content: string;
};

/**
 * Split a source file's text into line-aligned chunks of ~desiredBytes.
 *
 * The algorithm: walk lines in order, accumulating into a current chunk
 * until adding the next line would exceed the budget. When that happens,
 * emit the current chunk and start a new one with the line that didn't fit.
 * Single lines longer than the budget become their own oversized chunk
 * (rare in real code, common in minified files which we deliberately skip
 * via the file-size cap in the walker anyway).
 */
export function chunkFile(
  filePath: string,
  source: string,
  language: string | null,
  desiredBytes: number = DESIRED_CHUNK_BYTES,
): Chunk[] {
  if (!source.trim()) return [];

  const lines = splitLinesKeepEndings(source);
  if (lines.length === 0) return [];

  const chunks: Chunk[] = [];
  let buffer: string[] = [];
  let bufferBytes = 0;
  let bufferStart = 1;

  const flush = (endLine: number) => {
    if (buffer.length === 0) return;
    chunks.push({
      filePath,
      startLine: bufferStart,
      endLine,
      language,
      content: buffer.join(""),
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineBytes = Buffer.byteLength(line, "utf8");
    const oneIndexed = i + 1;

    // If the buffer already has content and the next line would push us
    // past the budget, emit the buffer and start fresh.
    if (buffer.length > 0 && bufferBytes + lineBytes > desiredBytes) {
      flush(oneIndexed - 1);
      buffer = [];
      bufferBytes = 0;
      bufferStart = oneIndexed;
    }

    buffer.push(line);
    bufferBytes += lineBytes;
  }
  flush(lines.length);

  return chunks;
}

// Splits a string into lines while preserving the original line endings.
// `text.split('\n')` discards the separator; we want each chunk to be
// re-joinable into a byte-exact copy of the file, which lets us reason
// about offsets and re-display chunks faithfully in the UI.
function splitLinesKeepEndings(text: string): string[] {
  const result: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      result.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) result.push(text.slice(start));
  return result;
}

// Map file extension to a language tag we store on the chunk. Matches the
// values we'd use in tree-sitter when we add AST chunking later, so the
// schema doesn't need to change between v0 (line-based) and v1 (AST). The
// language is informational for now — it surfaces in search results to help
// the LLM and isn't used by BM25 scoring.
export function detectLanguage(extension: string): string | null {
  switch (extension) {
    case ".ts": case ".tsx": return "typescript";
    case ".js": case ".jsx": case ".mjs": case ".cjs": return "javascript";
    case ".py": return "python";
    case ".rs": return "rust";
    case ".go": return "go";
    case ".java": return "java";
    case ".kt": return "kotlin";
    case ".scala": return "scala";
    case ".swift": return "swift";
    case ".rb": return "ruby";
    case ".php": return "php";
    case ".c": case ".h": return "c";
    case ".cpp": case ".cc": case ".cxx": case ".hpp": return "cpp";
    case ".cs": return "csharp";
    case ".fs": return "fsharp";
    case ".lua": return "lua";
    case ".sh": case ".bash": case ".zsh": return "bash";
    case ".sql": return "sql";
    case ".dart": return "dart";
    case ".elm": return "elm";
    case ".ex": case ".exs": return "elixir";
    case ".clj": case ".cljs": return "clojure";
    default: return null;
  }
}
