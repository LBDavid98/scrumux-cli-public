# Third-party licenses

scrumux itself is MIT — see [`LICENSE`](LICENSE). This file covers third-party
material **redistributed inside this repository**, which is a different thing
from a dependency the package manager fetches for you.

---

## tree-sitter grammars (`tools/grammars/*.wasm`)

Thirteen WebAssembly grammar blobs are committed to this repository so that
building a code index needs no compiler, no node-gyp, no emscripten and no
Python — which is what lets `scrumux graph code build` work on a bare Windows
machine. They are **source-repo assets only**: they never deploy into a governed
repo, and nothing under `.deploy-claude/` references them.

Each blob was extracted unmodified from the official `tree-sitter-*` npm tarball
published by the tree-sitter organisation. Byte counts and SHA-256 digests for
every blob are recorded in [`tools/grammars/README.md`](tools/grammars/README.md),
so what is committed here can be checked against what was published there.

**Every one of these is under the MIT License.** The copyright notices below are
reproduced as required by that licence.

| Blob | Upstream | Copyright |
|---|---|---|
| `tree-sitter-bash.wasm` | [tree-sitter/tree-sitter-bash](https://github.com/tree-sitter/tree-sitter-bash) | Copyright (c) 2017 Max Brunsfeld |
| `tree-sitter-c.wasm` | [tree-sitter/tree-sitter-c](https://github.com/tree-sitter/tree-sitter-c) | Copyright (c) 2014 Max Brunsfeld |
| `tree-sitter-c_sharp.wasm` | [tree-sitter/tree-sitter-c-sharp](https://github.com/tree-sitter/tree-sitter-c-sharp) | Copyright (c) 2014-2023 Max Brunsfeld, Damien Guard, Amaan Qureshi, and contributors. |
| `tree-sitter-cpp.wasm` | [tree-sitter/tree-sitter-cpp](https://github.com/tree-sitter/tree-sitter-cpp) | Copyright (c) 2014 Max Brunsfeld |
| `tree-sitter-go.wasm` | [tree-sitter/tree-sitter-go](https://github.com/tree-sitter/tree-sitter-go) | Copyright (c) 2014 Max Brunsfeld |
| `tree-sitter-java.wasm` | [tree-sitter/tree-sitter-java](https://github.com/tree-sitter/tree-sitter-java) | Copyright (c) 2017 Ayman Nadeem |
| `tree-sitter-javascript.wasm` | [tree-sitter/tree-sitter-javascript](https://github.com/tree-sitter/tree-sitter-javascript) | Copyright (c) 2014 Max Brunsfeld |
| `tree-sitter-php.wasm` | [tree-sitter/tree-sitter-php](https://github.com/tree-sitter/tree-sitter-php) | Copyright (c) 2017 Josh Vera, GitHub |
| `tree-sitter-python.wasm` | [tree-sitter/tree-sitter-python](https://github.com/tree-sitter/tree-sitter-python) | Copyright (c) 2016 Max Brunsfeld |
| `tree-sitter-ruby.wasm` | [tree-sitter/tree-sitter-ruby](https://github.com/tree-sitter/tree-sitter-ruby) | Copyright (c) 2016 Rob Rix |
| `tree-sitter-rust.wasm` | [tree-sitter/tree-sitter-rust](https://github.com/tree-sitter/tree-sitter-rust) | Copyright (c) 2017 Maxim Sokolov |
| `tree-sitter-tsx.wasm` | [tree-sitter/tree-sitter-typescript](https://github.com/tree-sitter/tree-sitter-typescript) | Copyright (c) 2017 Max Brunsfeld |
| `tree-sitter-typescript.wasm` | [tree-sitter/tree-sitter-typescript](https://github.com/tree-sitter/tree-sitter-typescript) | Copyright (c) 2017 Max Brunsfeld |

`tree-sitter-tsx.wasm` and `tree-sitter-typescript.wasm` are two grammars from
the one `tree-sitter-typescript` package, which is why twelve upstream projects
produce thirteen blobs.

### The MIT License

Each grammar above ships under the following terms, with the copyright notice
from its own row substituted for `<copyright holder>`:

```
MIT License

Copyright (c) <copyright holder>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Everything else

Every other third-party component is an ordinary dependency resolved by npm
from `package.json` and pinned by `package-lock.json`. None of it is vendored
into this repository, and each carries its own licence in `node_modules/`.
