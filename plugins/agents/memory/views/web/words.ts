/** Every word Memory's web front end shows, to be changed by the app (`memory.<key>`). */
import { defineWords } from "../../../../../hosts/web/words.ts";

export const say = defineWords("memory", {
  // The page and its space tab
  memories: "Memories",
  pageIntro:
    "What agents remember across chats. {star} Core memories are always in mind; the rest come up when they're relevant.",
  spaceIntro:
    "What agents learned in this space. {star} Core memories are always in mind; the rest come up when they're relevant.",
  personalSpace: "Personal",
  // The list
  emptyTitle: "Nothing remembered yet",
  emptyBody:
    "As you talk, agents keep here what will matter later: who you are, what you prefer, what you decided.",
  startChat: "Start a chat",
  searchMemories: "Search memories",
  whichMemories: "Which memories",
  all: "All",
  core: "Core",
  coreMemories: "Core memories",
  allMemories: "All memories",
  noMatch: "No memories match “{search}”.",
  noCore: "No core memories yet.",
  // Whom a memory is about
  aboutYou: "About you",
  aboutPerson: "About {name}",
  aboutAgent: "About {name}",
  aboutChats: "About particular chats",
  aboutEveryone: "About everyone",
  aboutOneChat: "About a chat",
  // One memory
  moreMenu: "This memory: more",
  moveToSpace: "Move to another space…",
  coreHint: "Core: always in mind",
  coreSr: "Core:",
  notedFromChat: "Noted from the chat",
  by: "By {name}",
  updated: "updated",
  was: "Was: {text}",
  chat: "Chat",
  // Moving a memory (the palette)
  moveTitle: "Move “{memory}” to…",
  findSpace: "Find a space",
  moveNote: "Agents then recall it as learned there, for the people in that space.",
  moveThis: "Move this memory to another space…",
  moveOne: "Move a memory to another space…",
  moveOneTitle: "Move a memory…",
  findMemory: "Find a memory",
  thisMemory: "This memory",
  thisSpace: "This space",
});
