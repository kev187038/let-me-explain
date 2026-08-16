# PROJECT LET-ME-EXPLAIN
Introduction: 
it's a plugin for a harness that is supposed to give Junior developer a better chance to learn with AI. Essentially the idea is to open a second window where every line of code is explained to the user, as well as every line of command line executed by the AI. 

We will refer to Coding Agent as the normal coding agent, and to the Teacher Agent as the agent that explains the user what is going on.

## Features:
0. Ideally Teacher Agent and actual Coding Agent coincide to use less tokens.
1. Chunk command / new code in lines as tokens: every token is explained as a line in its context. Worth considering chunking in by word. 
2. Code /Command line choice: the user can in this second window choose the lines that the agent needs to explain.
3. Teacher-Agent instructions: a set of instructions to define for the teacher agent. Among these, we wanna make the learning process as smooth as possible, so we need to curb the usual AI lingo: things need to be easy to explain, and explanations need to be **brief**. No walls of text that are an eye-sore to read. Every token, explained, simply. After this, **the second part is the wider context of what is being done in that command / edit to file and why** (we are solving this bug..., this feature needs this because..., etc...). This too needs to be a small section. 
The agent needs to also stop putting useless comments above the code it makes, just the comment that explains the whole page or borderline problems are allowed.
4. Let-me-write feature: the teacher agent also allows the choice to the user to write the command or the code themselves to learn by hand and memory as well. A simple YES/NO for the current page or command that it wants to execute.
5. Question section: a separated section for any question the user wants to ask on the code/command being done.
6. Simple installation to the harness as a plug-in. Claude Code, Codex or OpenCode.

