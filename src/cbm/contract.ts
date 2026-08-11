export const CBM_CONTRACT_VERSION = "2";

/** A single hit from `search_graph`. */
export interface SearchHit {
  name: string;
  qualified_name: string;
  label: string;
  file_path: string;
  start_line: number;
  end_line: number;
  rank: number;
}

/** `gk graph search` result — mirrors CBM `search_graph`. */
export interface SearchResult {
  total: number;
  search_mode: string;
  results: SearchHit[];
  has_more: boolean;
}

/** One hop in a call tree — mirrors CBM `trace_path` callers/callees entries. */
export interface TraceHop {
  name: string;
  qualified_name: string;
  hop: number;
}

/** `gk graph trace` result — mirrors CBM `trace_path`. */
export interface TraceResult {
  function: string;
  direction: "inbound" | "outbound" | "both";
  callers: TraceHop[];
  callees: TraceHop[];
}

/** `gk graph query` result — mirrors CBM `query_graph` (rows are positional, keyed by columns). */
export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  total: number;
}
