# council
An MCP server that runs structured, bounded critique rounds between Claude Code and Codex, each keeping its own session context.

Two models, both already working on your problem, both with their own context. Getting one to check the other means copy-pasting a wall of text in each direction, every round — so mostly you don't bother.

council turns that into one command per window. Both models answer independently, neither seeing the other first. Then they trade critiques, each disagreement required to quote the line it contests and cite something real. It stops after a fixed number of rounds — because two models agreeing is the least trustworthy signal in the system, and a round cap is the only stopping rule that doesn't depend on them being honest.
