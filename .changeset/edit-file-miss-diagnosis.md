---
"@cycgraph/tools": patch
---

edit_file's no-match refusal now diagnoses search-output poisoning: a find text carrying `NN:` line-number prefixes, or one that matches the file except for whitespace and indentation, is named as such instead of the generic "read the file and use an exact snippet".
