/**
 * THE POWERSHELL DIALECT MATRIX — the frozen oracle for the four walls' second
 * arm, and the ONE copy of it.
 *
 * Read by two things that must never disagree: `test/unit/walls-powershell.test.ts`,
 * which drives the wall `main()` functions in process so v8 sees the branches,
 * and `tools/walls-parity.mjs --mode powershell`, which drives the BUILT
 * BUNDLES as real processes so what ships is what was asserted about. A second
 * copy of a matrix is a second thing to keep in step (D-0010), and the bash
 * side already learned that lesson twice.
 *
 * WHY THIS MODE IS AN ASSERTION MATRIX AND NOT A DIFFERENTIAL. Every other
 * wall gate in this repo compares the TypeScript verdict against the bash
 * hook's, because bash is the production owner and parity is the contract. It
 * cannot be here: `.deploy-claude/hooks/*.sh` are POSIX and know nothing about
 * PowerShell, so there is no second implementation to compare against and
 * feeding these payloads to the bash masters would assert only that they allow
 * everything. The dialect is ADDITIVE — the bash-side differential stays at
 * 1648/1648 identical, which is the mechanical proof that nothing here reached
 * back into the POSIX arm — and these rows are what hold the new arm.
 *
 * EVERY ROW CAME FROM AN ADVERSARIAL PASS, not from the implementation. Wave 1
 * walked the shapes the brief named (wrapped, aliased, abbreviated,
 * case-folded, quoted, backtick-escaped). Wave 2 deliberately went after what
 * the implementation had NOT been written for, and found nine live gaps:
 *
 *   - the whole cmd.exe surface behind PowerShell (`cmd /c "rd /s /q X"`,
 *     `rd /s /q X`, `del /s /q`), which no PowerShell parameter test can see;
 *   - `Start-Process cmd -ArgumentList "/c rd /s /q X"`, where the payload
 *     parameter belongs to Start-Process and the host is an argument, so a
 *     test anchored on the command word matched neither half;
 *   - `-e`, the single-letter abbreviation of `-EncodedCommand`, excluded by a
 *     length guard;
 *   - a two-LAYER payload (`pwsh -c "iex '...'"`), which one expansion pass
 *     unwrapped into an `iex` line it then never looked inside;
 *   - `Get-Content ".\.env"`, where the character before `.env` is a
 *     backslash and none of the secret patterns anchor on one;
 *   - and, in wave 1, `Copy-Item .env.example .env` blocking — the first-day
 *     setup step D-0085 exists to permit — because the PowerShell gate had
 *     licensed the POSIX operand splitter to judge a PowerShell command.
 *
 * All six classes are closed and every one of them is a row below. The two
 * that are NOT closed are rows too, marked FINDING, because a wall's known
 * limits belong in the same table as its guarantees.
 *
 * A row is `[wall, command, expected exit code, why]`. 2 blocks, 0 allows.
 */

/** The four walls, by bundle name. */
export const D = 'block-destructive';
export const S = 'block-secret-reads';
export const L = 'block-direct-llm';
export const U = 'block-upstream-edit';

/** `-EncodedCommand`'s blob is base64 of UTF-16LE, which is what PowerShell requires. */
const b64 = (s) => Buffer.from(s, 'utf16le').toString('base64');

export const PS_CASES = [

  // ---------------- block-destructive ----------------
  [D, 'Remove-Item -Recurse -Force C:/repo', 2, 'baseline'],
  [D, 'REMOVE-ITEM -RECURSE -FORCE C:/repo', 2, 'case: PowerShell is case-insensitive'],
  [D, 'ReMoVe-ItEm -ReCuRsE -FoRcE C:/repo', 2, 'case: mixed'],
  [D, 'Remove-Item -Rec -For C:/repo', 2, 'abbrev: documented prefix'],
  [D, 'Remove-Item -R -F C:/repo', 2, 'abbrev: single letter'],
  [D, 'Remove-Item -Recurse:$true -Force:$true C:/repo', 2, 'colon-value switch form'],
  [D, 'ri -r -f C:/repo', 2, 'alias ri'],
  [D, 'rd -Recurse -Force C:/repo', 2, 'alias rd'],
  [D, 'erase -Recurse -Force C:/repo', 2, 'alias erase'],
  [D, '& Remove-Item -Recurse -Force C:/repo', 2, 'call operator'],
  [D, '$x = Remove-Item -Recurse -Force C:/repo', 2, 'assignment prefix'],
  [D, 'Start-Process Remove-Item -Recurse -Force C:/repo', 2, 'Start-Process wrapper'],
  [D, 'iex "Remove-Item -Recurse -Force C:/repo"', 2, 'iex literal payload'],
  [D, 'Invoke-Expression "Remove-Item -Rec -For C:/repo"', 2, 'iex long name'],
  [D, 'pwsh -Command "Remove-Item -Recurse -Force C:/repo"', 2, '-Command payload'],
  [D, 'Remove-Item -Recurse -Force `C:/repo', 2, 'backtick escape in operand'],
  [D, "Remove-Item -Recurse -Force 'C:/repo'", 2, 'single-quoted operand'],
  [D, 'Remove-Item "-WhatIf" -Recurse -Force C:/repo', 2, 'QUOTED -WhatIf is an argument, not a switch'],
  [D, "Remove-Item '-WhatIf' -Recurse -Force C:/repo", 2, 'single-quoted -WhatIf'],
  [D, 'Get-ChildItem C:/repo | Remove-Item -Recurse -Force', 2, 'pipeline delete'],
  [D, 'Clear-Content C:/repo/important.log', 2, 'Clear-Content'],
  [D, 'clc C:/repo/important.log', 2, 'alias clc'],
  [D, 'Format-Volume -DriveLetter D', 2, 'Format-Volume'],
  [D, 'Remove-Item -Recurse -Force C:/repo; $env:HARNESS_BACKUP_DONE=1', 2, 'attestation AFTER the act'],
  [D, '[IO.Directory]::Delete("C:/repo", $true)', 2, '.NET recursive delete'],
  [D, '& psql -c "DROP DATABASE prod"', 2, 'DB purge via call operator'],
  [D, 'PSQL -c "DROP DATABASE prod"', 2, 'DB client, case-folded'],
  [D, '$out = git reset --hard HEAD~5', 2, 'git history via assignment'],
  [D, 'git push --force origin main', 2, 'bare force push (posix arm, unchanged)'],
  // must NOT block
  [D, 'Remove-Item -Recurse -Force -WhatIf C:/repo', 0, '-WhatIf is a dry run'],
  [D, 'Remove-Item -Recurse -Force C:/repo -WhatIf', 0, '-WhatIf trailing'],
  [D, 'Remove-Item -Recurse -Force $env:TEMP/build', 0, 'temp exemption'],
  [D, 'Remove-Item -Recurse -Force "$env:TEMP/build"', 0, 'quoted temp path'],
  [D, '$env:HARNESS_BACKUP_DONE=1; Remove-Item -Recurse -Force C:/repo', 0, 'attestation BEFORE the act'],
  [D, 'Remove-Item C:/repo/one.txt', 0, 'no -Recurse -Force'],
  [D, 'Remove-Item -Force C:/repo/one.txt', 0, 'force without recurse'],
  [D, 'Get-ChildItem -Recurse -Force C:/repo', 0, 'a listing is not a delete'],
  [D, 'Write-Output "we never run Remove-Item -Recurse -Force here"', 0, 'prose in a quoted string'],
  [D, 'Set-Content notes.md "Remove-Item -Recurse -Force"', 0, 'writing the words to a file'],

  // ---------------- block-secret-reads ----------------
  [S, 'Get-Content .env', 2, 'baseline'],
  [S, 'GET-CONTENT .env', 2, 'case'],
  [S, 'gc .env', 2, 'alias gc'],
  [S, 'cat .env', 2, 'alias cat (posix arm too)'],
  [S, 'type .env', 2, 'alias type'],
  [S, 'Get-Content -Path .env', 2, 'flag-attached path'],
  [S, 'Get-Content -Path:.env', 2, 'colon-attached path'],
  [S, 'Get-Content -LiteralPath .env', 2, 'LiteralPath'],
  [S, 'Select-String -Path .env -Pattern KEY', 2, 'Select-String'],
  [S, 'sls KEY .env', 2, 'alias sls'],
  [S, 'Import-Csv secrets.json', 2, 'Import-Csv'],
  [S, '[IO.File]::ReadAllText(".env")', 2, '.NET read'],
  [S, '[System.IO.File]::ReadAllBytes(".env")', 2, '.NET read, full namespace'],
  [S, 'Get-ChildItem . | Get-Content .env', 2, 'pipeline into a reader'],
  [S, 'Copy-Item .env C:/out/x', 2, 'copy SOURCE is a read'],
  [S, 'Copy-Item -Destination C:/out .env', 2, '-Destination named: every positional is a source'],
  [S, 'Move-Item .env C:/out/x', 2, 'move source'],
  [S, 'iex "Get-Content .env"', 2, 'iex payload'],
  [S, 'Get-Content id_rsa', 2, 'ssh key'],
  [S, 'Get-Content ~/.npmrc', 2, 'npmrc'],
  // must NOT block
  [S, 'Get-Content .env.example', 0, 'the .example exemption'],
  [S, 'Copy-Item .env.example .env', 0, 'first-day setup: destination is a write'],
  [S, 'Copy-Item .env.example .env; Get-Content .env', 2, '...but a later read still blocks'],
  [S, 'Write-Output "never read .env"', 0, 'prose, no reader'],
  [S, 'Get-ChildItem .env', 0, 'listing metadata is not reading contents'],
  [S, 'Set-Content .env "x"', 0, 'writing a secret is not reading one'],

  // ---------------- block-direct-llm ----------------
  [L, 'Invoke-WebRequest https://api.openai.com/v1/chat', 2, 'baseline'],
  [L, 'INVOKE-WEBREQUEST https://api.openai.com/v1/chat', 2, 'case'],
  [L, 'iwr https://api.openai.com/v1/chat', 2, 'alias iwr'],
  [L, 'irm https://api.anthropic.com/v1/messages', 2, 'alias irm'],
  [L, 'Invoke-RestMethod -Uri https://api.openai.com/v1/chat', 2, 'RestMethod with -Uri'],
  [L, 'curl https://api.openai.com/v1/chat', 2, 'curl (a PS alias for iwr on Windows)'],
  [L, 'wget https://api.openai.com/v1/chat', 2, 'wget alias'],
  [L, '(New-Object Net.WebClient).DownloadString("https://api.openai.com/v1")', 2, 'WebClient'],
  [L, '[Net.WebClient]::new().DownloadString("https://api.openai.com/v1")', 2, 'WebClient type accessor'],
  [L, 'iex "irm https://api.openai.com/v1/chat"', 2, 'iex payload'],
  [L, 'pwsh -EncodedCommand ' + Buffer.from('irm https://api.openai.com/v1', 'utf16le').toString('base64'), 2, '-EncodedCommand base64'],
  // must NOT block
  [L, 'Write-Output "we do not call api.openai.com directly"', 0, 'prose names a provider'],
  [L, 'Invoke-WebRequest https://example.com/x', 0, 'a call to something else'],

  // ---------------- block-upstream-edit ----------------
  [U, 'Set-Content .claude/scripts/scrumux "x"', 2, 'baseline'],
  [U, 'Set-Content .claude\\scripts\\scrumux "x"', 2, 'BACKSLASH separator'],
  [U, 'SET-CONTENT .claude/scripts/scrumux "x"', 2, 'case'],
  [U, 'sc .claude/dist/block-destructive.mjs "x"', 2, 'alias sc'],
  [U, 'Out-File -FilePath .claude/schemas/log.json', 2, 'Out-File'],
  [U, 'Add-Content .claude/scripts/scrumux "x"', 2, 'Add-Content'],
  [U, 'New-Item -Force -Path .claude/scripts/scrumux', 2, 'New-Item -Force'],
  [U, '"x" > .claude/scripts/scrumux', 2, 'redirection'],
  [U, '"x" >> .claude/scripts/scrumux', 2, 'append redirection'],
  [U, 'Remove-Item .claude/dist/block-destructive.mjs', 2, 'delete the machinery'],
  [U, 'Copy-Item evil.sh .claude/dist/block-destructive.mjs', 2, 'overwrite by copy'],
  [U, 'Rename-Item .claude/scripts/scrumux x', 2, 'rename'],
  [U, '[IO.File]::WriteAllText(".claude/scripts/scrumux", $s)', 2, '.NET write'],
  [U, 'python -c "open(\'.claude/scripts/scrumux\',\'w\')"', 2, 'interpreter route (posix arm)'],
  [U, 'iex "Set-Content .claude/scripts/scrumux x"', 2, 'iex payload'],
  [U, 'Set-Content -WhatIf .claude/scripts/scrumux "x"', 2, '-WhatIf is NOT honoured by this wall'],
  // must NOT block
  [U, 'Get-Content .claude/scripts/scrumux', 0, 'reading the machinery is fine'],
  [U, 'Select-String scrumux .claude/scripts/scrumux', 0, 'grepping it is fine'],
  [U, 'New-Item -Path .claude/scripts/scrumux', 0, 'New-Item without -Force does not clobber'],
  [U, 'Write-Output "do not edit .claude/scripts/scrumux"', 0, 'prose about the machinery (I-0134)'],

  // ===================== ADVERSARIAL WAVE 2 =====================

  // escapes and odd spellings
  [D, 'Re`move-Item -Recurse -Force C:/repo', 2, 'backtick INSIDE the cmdlet name'],
  [D, 'Remove-Item -Recurse -Force C:/repo # trailing comment', 2, 'trailing PS comment'],
  [D, 'Remove-Item `\n  -Recurse -Force C:/repo', 2, 'backtick line continuation'],
  [D, 'Remove-Item -Path C:/repo -Recurse -Force', 2, '-Path named parameter'],
  [D, 'Remove-Item -LiteralPath C:/repo -Recurse -Force', 2, '-LiteralPath'],
  [D, 'rm -Recurse -Force C:/repo', 2, 'rm alias with PS params'],
  [D, 'Remove-Item -Recurse -Force -Confirm C:/repo', 2, '-Confirm must NOT exempt'],
  [D, 'Remove-Item -RECURSE -FORCE -WHATIF C:/repo', 0, '-WHATIF uppercase must exempt'],
  [D, 'Remove-Item -wh -Recurse -Force C:/repo', 0, '-wh abbreviates -WhatIf'],

  // cmd.exe reached from PowerShell
  [D, 'cmd /c "rd /s /q C:/repo"', 2, 'cmd.exe recursive delete via /c'],
  [D, 'cmd.exe /c "rmdir /s /q C:/repo"', 2, 'cmd.exe rmdir'],
  [D, 'cmd /c "del /s /q C:/repo/*"', 2, 'cmd.exe del /s /q'],
  [D, 'Start-Process cmd -ArgumentList "/c rd /s /q C:/repo"', 2, 'Start-Process into cmd'],
  [D, 'rd /s /q C:/repo', 2, 'bare cmd-style switches'],

  // encoded / nested payloads
  [D, 'powershell -enc ' + b64('Remove-Item -Recurse -Force C:/repo'), 2, '-enc abbreviation of -EncodedCommand'],
  [D, 'powershell -e ' + b64('Remove-Item -Recurse -Force C:/repo'), 2, '-e abbreviation'],
  [D, 'pwsh -c "iex \'Remove-Item -Rec -For C:/repo\'"', 2, 'nested -Command then iex'],
  [S, 'powershell -EncodedCommand ' + b64('Get-Content .env'), 2, 'encoded secret read'],
  [U, 'powershell -EncodedCommand ' + b64('Set-Content .claude/scripts/scrumux x'), 2, 'encoded machinery write'],

  // secret reads, harder
  [S, 'Get-Content -Raw .env', 2, '-Raw switch before the path'],
  [S, '$c = Get-Content .env', 2, 'assigned read'],
  [S, 'Get-Content ".\\.env"', 2, 'windows relative path with backslash'],
  [S, 'gc .env | Select-String KEY', 2, 'read piped onward'],
  [S, 'Get-Content .env.production.local', 2, 'multi-segment env file'],
  [S, 'Get-Content prod.env', 2, 'name.env form'],
  [S, 'Copy-Item -Path .env -Destination C:/out', 2, '-Path source with -Destination'],
  [S, 'Get-Content .env.template', 0, 'template exemption'],

  // provider calls, harder
  [L, 'irm "https://api.openai.com/v1/chat"', 2, 'quoted url'],
  [L, 'Invoke-RestMethod -Uri "https://API.OPENAI.COM/v1"', 2, 'uppercase host'],
  [L, '$r = iwr https://api.groq.com/openai/v1', 2, 'assigned, groq'],
  [L, 'iwr -Uri https://openrouter.ai/api/v1/chat', 2, 'openrouter'],
  [L, 'Invoke-WebRequest https://bedrock-runtime.us-east-1.amazonaws.com/x', 2, 'bedrock'],

  // upstream edits, harder
  [U, 'Set-Content -Path .claude\\dist\\block-destructive.mjs -Value x', 2, 'backslash + named params'],
  [U, 'Move-Item evil.sh .claude/dist/block-destructive.mjs', 2, 'move onto the machinery'],
  // R-013 closed this. The bare directory was unprotected in BOTH dialects
  // because every pattern required a `/` with something after it, so a write
  // INTO the machinery that never named a protected FILE went through.
  [U, 'Expand-Archive x.zip -DestinationPath .claude/scripts', 2, 'R-013: a bare protected DIRECTORY as an operand'],
  [U, 'Expand-Archive x.zip -DestinationPath .claude/scripts/', 2, 'the trailing-slash spelling of the same'],
  [U, 'Move-Item evil .claude/dist', 2, 'R-013: bare directory, Move-Item'],
  [U, 'Copy-Item x agents/lib', 0, 'a repo\'s own agents/lib is not machinery'],
  // ...and the false-positive edge the boundary exists for. A repo may
  // legitimately own a longer name that merely STARTS with a protected
  // directory's name; a string-prefix test would have refused it.
  [U, 'Set-Content .claude/scriptsomething x', 0, 'R-013 boundary: prefix-only name stays allowed'],
  [U, 'Set-Content .claude/disty x', 0, 'R-013 boundary: prefix-only, dist'],
  [U, 'Copy-Item x agents/library', 0, 'R-013 boundary: prefix-only, agents/lib'],
  // The PowerShell stream redirects, glued, now that the shared helper reads
  // the fd- and &-prefixed forms.
  [U, 'Write-Output x 2>.claude/dist/y.mjs', 2, 'R-013: glued fd redirect, PowerShell'],
  [U, 'Write-Output x *>.claude/dist/y.mjs', 2, 'R-013: PowerShell all-streams redirect, glued'],
  [U, 'Tee-Object -FilePath .claude/scripts/scrumux', 2, 'Tee-Object'],
  [U, 'node -e "require(\'fs\').writeFileSync(\'.claude/scripts/scrumux\',\'x\')"', 2, 'node interpreter route'],
  [U, 'Set-Content agents/lib/schema_check.py "x"', 0, 'the harness ships no python'],
  [U, 'Set-Content .claude/agents/debugger.md "x"', 2, 'agent briefs are frozen machinery'],
  [U, 'Test-Path .claude/scripts/scrumux', 0, 'Test-Path is a reader'],
];
