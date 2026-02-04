import type { NewTool } from "@/interfaces/index.ts";

import ask_question from "./ask_question.ts";
import create_thread from "./create_thread.ts";
import end_thread from "./end_thread.ts";
import create_task from "./create_task.ts";
import http_request from "./http_request.ts";
import read_file from "./read_file.ts";
import write_file from "./write_file.ts";
import list_directory from "./list_directory.ts";
import verbal_pause from "./verbal_pause.ts";
import get_current_time from "./get_current_time.ts";
import search_files from "./search_files.ts";
import fetch_text from "./fetch_text.ts";
import run_command from "./run_command.ts";
import wait from "./wait.ts";
import save_asset from "./save_asset.ts";
import fetch_asset from "./fetch_asset.ts";
// RAG tools
import search_knowledge from "./search_knowledge.ts";
import ingest_document from "./ingest_document.ts";
import list_namespaces from "./list_namespaces.ts";
import delete_document from "./delete_document.ts";
// Multi-agent tools
import update_my_memory from "./update_my_memory.ts";

/**
 * Registry of all built-in native tools available to agents.
 * 
 * Includes tools for:
 * - Thread and task management (create_thread, end_thread, create_task)
 * - File operations (read_file, write_file, list_directory, search_files)
 * - HTTP and asset handling (http_request, fetch_text, save_asset, fetch_asset)
 * - RAG operations (search_knowledge, ingest_document, list_namespaces, delete_document)
 * - Utility tools (ask_question, verbal_pause, get_current_time, wait, run_command)
 */
export const nativeTools: { [key: string]: NewTool } = {
    ask_question,
    create_thread,
    end_thread,
    create_task,
    http_request,
    read_file,
    write_file,
    list_directory,
    verbal_pause,
    get_current_time,
    search_files,
    fetch_text,
    run_command,
    wait,
    save_asset,
    fetch_asset,
    // RAG tools
    search_knowledge,
    ingest_document,
    list_namespaces,
    delete_document,
    // Multi-agent tools
    update_my_memory,
};


/**
 * Get a dictionary of native tools
 * @example
 * ```typescript
 * const nativeTools = getNativeTools();
 * console.log(nativeTools);
 * ```
 * @returns A dictionary of native tools. The key is the tool name and the value is the tool object.
 */
export function getNativeTools(): { [key: string]: NewTool } {
    return nativeTools;
}
