import type { NewTool } from "@/types/index.ts";

import delegate from "@/resources/tools/delegate/index.ts";
import create_thread from "@/resources/tools/create_thread/index.ts";
import end_thread from "@/resources/tools/end_thread/index.ts";
import http_request from "@/resources/tools/http_request/index.ts";
import read_file from "@/resources/tools/read_file/index.ts";
import write_file from "@/resources/tools/write_file/index.ts";
import list_directory from "@/resources/tools/list_directory/index.ts";
import get_current_time from "@/resources/tools/get_current_time/index.ts";
import search_files from "@/resources/tools/search_files/index.ts";
import search_code from "@/resources/tools/search_code/index.ts";
import apply_patch from "@/resources/tools/apply_patch/index.ts";
import show_file_diff from "@/resources/tools/show_file_diff/index.ts";
import restore_file_version from "@/resources/tools/restore_file_version/index.ts";
import fetch_text from "@/resources/tools/fetch_text/index.ts";
import run_command from "@/resources/tools/run_command/index.ts";
import persistent_terminal from "@/resources/tools/persistent_terminal/index.ts";
import wait from "@/resources/tools/wait/index.ts";
import save_asset from "@/resources/tools/save_asset/index.ts";
import fetch_asset from "@/resources/tools/fetch_asset/index.ts";
import search_knowledge from "@/resources/tools/search_knowledge/index.ts";
import ingest_document from "@/resources/tools/ingest_document/index.ts";
import list_namespaces from "@/resources/tools/list_namespaces/index.ts";
import delete_document from "@/resources/tools/delete_document/index.ts";
import update_my_memory from "@/resources/tools/update_my_memory/index.ts";
import list_skills from "@/resources/tools/list_skills/index.ts";
import load_skill from "@/resources/tools/load_skill/index.ts";
import read_skill_resource from "@/resources/tools/read_skill_resource/index.ts";

export const nativeTools: { [key: string]: NewTool } = {
    delegate,
    create_thread,
    end_thread,
    http_request,
    read_file,
    write_file,
    list_directory,
    get_current_time,
    search_files,
    search_code,
    apply_patch,
    show_file_diff,
    restore_file_version,
    fetch_text,
    run_command,
    persistent_terminal,
    wait,
    save_asset,
    fetch_asset,
    search_knowledge,
    ingest_document,
    list_namespaces,
    delete_document,
    update_my_memory,
    list_skills,
    load_skill,
    read_skill_resource,
};

export function getNativeTools(): { [key: string]: NewTool } {
    return nativeTools;
}
