---
"@cycgraph/tools": minor
---

`safeGitRef` validates a name against git's own ref-format rules before it may enter git argv: a leading dash is how a branch name becomes `--upload-pack=…` (CWE-88), and refspec, glob, and reflog syntax turn one ref argument into another. Ref names arrive from PR metadata, which a fork author controls; callers refuse an unsafe name rather than sanitize it. `pushBranch` failures now name git's actual reason (rejected, denied, protection) instead of only "Command failed: git push …" — the actionable line lives in stderr, which the generic exec message buries. `cloneToBranch` passes `--` before its positional arguments, so a repository path beginning with a dash can never parse as a git option.
