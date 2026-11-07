# Changelog

## [1.1.0](https://github.com/DarWiM/bitrix24-mcp-bridge/compare/bitrix24-mcp-bridge-v1.0.0...bitrix24-mcp-bridge-v1.1.0) (2026-11-07)


### Features

* **core:** remind to clean the downloads folder ([1e6ea94](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/1e6ea94d8884fd2c8e694c778161af31712fd549))


### Bug Fixes

* **core:** explain missing tasks, repeated Gantt links and running out of time ([620a2dc](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/620a2dc371e6c479874fb91921c2adb9623e8df5))
* **core:** move tasks returned to the backlog out of the sprint column ([438b038](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/438b0385475e24d267f802f5d4fda43068624c7d))
* move backlog tasks out of the sprint column; clearer errors; downloads reminder ([8dfbe39](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/8dfbe39720931d8a50a49e8862498e0d18c3af9f))

## [1.0.0](https://github.com/DarWiM/bitrix24-mcp-bridge/compare/bitrix24-mcp-bridge-v0.5.0...bitrix24-mcp-bridge-v1.0.0) (2026-11-06)


### ⚠ BREAKING CHANGES

* remove action catalog and traffic capture pipeline
* **tools:** bitrix_call and the actions.json catalog are gone; only built-in operations can be called.

### Features

* **core:** add domain operation model and registry ([6816f2c](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/6816f2c8a78b6b986ccacfcce72b51db6a451733))
* **core:** add task description and chat message operations ([ccfd7d9](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/ccfd7d961f2a94ca210e002eb15f3bf3d6c0b5a9))
* **core:** attach a local file to a task ([8a813bb](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/8a813bb9553578cc828dc6285467dde2645459ce))
* **core:** close tasks through Definition of Done and reopen them ([2dd0bc6](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/2dd0bc6a136cee8df2552c6cbf840974e47eb80c))
* **core:** define read operations ([48088c4](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/48088c445f828982dca72169429f466fdb0a4981))
* **core:** edit task description fragments, tags, checklist and plan dates ([7d49508](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/7d4950881765d96c900efc966f920e7334e22fb3))
* **core:** manage related tasks, parent task and Gantt links ([34caa49](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/34caa49853c9807d4e8f70c7823b293b1200fb1d))
* **core:** manage task responsible, accomplices and auditors ([bef0774](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/bef07743aabd75c8961a2e17289ccae0ab2a4c61))
* **core:** mark own reminders in the list ([1bc7cdf](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/1bc7cdff0d41d6ed50b5ef5b236da0729d73d4f3))
* **core:** move tasks between backlog and sprint and create tasks on the board ([f468ecd](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/f468ecd9cbcdb20030d6f6ff33f7234b38e9a5d3))
* **core:** move tasks between sprint columns and add task results ([f441923](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/f44192334bde6674b408ba579b6a02104bc64d96))
* **core:** reply, edit and react in chats and post to task chats ([21ccae8](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/21ccae8acbff77afe0035d0cd0f88eb43841fb48))
* **core:** run hand-off operations over task batches ([ed319dd](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/ed319dd3e68d331bdf93371a4cc68360aeaf0233))
* **core:** set task priority, deadline, mute state and reminders ([022a340](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/022a340ce9c4ffd464869393eb189c06f097da0e))
* **daemon:** execute domain operations over the socket ([c0f0363](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/c0f0363a6b29fadab331c83d4490bcc518ab6381))
* **setup:** add switch to disable mutating operations ([14457b9](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/14457b963a572a43885446369f0403803ff5c634))
* **setup:** remove obsolete runtime files on upgrade ([f32d65e](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/f32d65ec87ca8f311ee9162426c1ecd67939cd66))
* **tools:** serve tools from domain operations and drop bitrix_call ([8fdc1bc](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/8fdc1bcdc38fdccc9ac78acc415407339f7b1279))


### Bug Fixes

* address final review minors ([d8e976f](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/d8e976f7c6251ebb8052a14f8bff0e472fa934ba))
* **config:** reject a non-boolean mutations setting ([b06df99](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/b06df996fb8e60945e0c9a41b81bb5ad0b872a0e))
* **core:** ask for DoD only in scrum projects ([d1b0a62](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/d1b0a62d22fed3e4e662fef5defe043bb64a6f83))
* **core:** cap maxPages to the long budget ([99bd2b6](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/99bd2b660c1acbf8b8efb2ed1e8b73fe4a12c3ca))
* **core:** check for a FINISH column right before each board write ([b264c33](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/b264c333045894b34c7714dd2e544cc464258c2a))
* **core:** describe re-reads, group removal and relation notifications honestly ([a165130](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/a16513083f1bc13c296e8874204a704bbc5672f4))
* **core:** detect collateral relation loss and keep a way back ([6fb0e7d](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/6fb0e7df5341b01b407500bf6d42765b28b12144))
* **core:** give each id field its own schema and resolve download portal from the link ([7d89726](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/7d89726c4d6e4cd4c98ff5e2bc29e016612b075a))
* **core:** give file upload a longer call timeout ([6a0e075](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/6a0e075d764d60d08675ebbdf8857b4206a8d211))
* **core:** give operations a time budget ([279fbc7](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/279fbc74025e1a79768cc6c7c2dd72f2e75a63a7))
* **core:** give two-request reads the long budget and cap the deadline reason ([1163dd3](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/1163dd3aee5553bd1491e3db96ed94f95ea23d2f))
* **core:** guard task creation and sprint placement against retries ([e20a81c](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/e20a81cc985b0e0faaedbc6532e55040e2fbd578))
* **core:** harden file attach ([d18617b](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/d18617b7483ffc10fde0bf3f7e9e1afeb03d3966))
* **core:** keep batch verdicts authoritative and within the time budget ([e7efe9e](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/e7efe9e273dece9f2c143ac5674b4178b0c2fe26))
* **core:** keep chat_calls paging under operation control ([81923b2](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/81923b22cbd7b4c2338b0e652ec3a6eb0c1390cb))
* **core:** keep the bridge data dir out of file attach ([fb6b30f](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/fb6b30f4236b2a574e34895e60e489799acfd454))
* **core:** leave slack in the upload budget ([83a84b8](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/83a84b8396b0fc9b9918da71d5b040cd167d321c))
* **core:** let file attach reuse bridge downloads ([2f4e19d](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/2f4e19d73e5f6c04364dc7944c023d0d0f6f048b))
* **core:** link Gantt tasks through classic REST ([9109e48](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/9109e48c98436093994bb8eb28fbf89c7339d028))
* **core:** list only real DoD criteria ([bcade7d](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/bcade7d5b6962bf3d1852861429c14c4e9b29705))
* **core:** name the env switch in the mutation refusal ([9a1359e](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/9a1359ec479a99cfe9cb3a618bf08600e98b7a76))
* **core:** never read an unknown project as DoD-free ([9e39acd](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/9e39acd2aa5586ce5eea78768a51f766d345bebc))
* **core:** re-read descriptions after writing ([d8c8802](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/d8c8802d90e5c76b1e05dc3a29d0ec84d8c1dfb1))
* **core:** refuse FINISH columns so closing goes through DoD ([36bfe48](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/36bfe485f475fadc847f0e7c2ba15ae82467ae0b))
* **core:** reject duplicate task ids in batches ([8e060f2](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/8e060f2e19a4af669b3614dac659a7063825ed30))
* **core:** reject reserved keys in agent params ([f930301](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/f9303010fd788cea0d41a55502e8ff02168c18a6))
* **core:** say nothing was written when the Gantt pre-read fails ([4b2e20b](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/4b2e20b1ec386ea4b84fdef6276cf29b61967c40))
* **core:** tighten description matching and checklist edits ([3905300](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/390530012b9286fe1d5751d6d7a8fc6e13408c28))
* **core:** tighten reminder checks ([0fb1e82](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/0fb1e8227a12f86c8354db79462b47a63221646f))
* **core:** verify member lists after writing them ([295febd](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/295febd2ab76f03948d712791ac0557a8e4dde78))
* **core:** verify mute and reminder deletion, compare times to the minute ([43e7bfe](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/43e7bfe310743d2573195798632c740175bda29c))
* **core:** warn about possible duplicates on write timeouts ([34124b0](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/34124b0018257d6250738ee3eadf191b294095b2))
* **core:** warn on unrecognised send replies and invisible edit text ([343c675](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/343c675d0e7741537d0cf78e9df7acb7521d19b7))
* **core:** warn that a description may have changed on write timeout ([ee2395f](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/ee2395f3dfb4091a7b7b1ed0e164a6a58ca055a4))
* **core:** warn that a failed chat send may have been delivered ([ea277d9](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/ea277d9c065225944b0a33d0b8114ca69ed03ab7))
* **extension:** keep numeric error codes in error text ([f76bd61](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/f76bd61b4f41adab52b875af812421f68333c285))
* **extension:** show REST 3.0 error code and message ([4af3cc1](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/4af3cc15cced374f3734ffe19f0dc5e0b5e65858))
* keep chat_calls order and sync:runtime stop under control ([5731b4a](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/5731b4a6b96ac469d908b5352e7db3a084ed2971))
* **mcp:** fail requests stranded on a replaced socket ([cbc9b09](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/cbc9b09d62ef49dc7797cacb4133efa5daf29db9))
* **mcp:** reconnect to a restarted daemon ([1bad694](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/1bad69401b0ca0854898615d75e1a9f62d07868c))
* **mcp:** recover the daemon connection after a failed handover ([d08e471](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/d08e47108fe8ecfe12ad321ba2cc726b779eee36))
* **setup:** stop the daemon reliably and show the effective mutation state ([d1e216e](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/d1e216e3954b7c8e3bd54fc5bb7fba5f02aad441))
* **tools:** reject duplicated action in download links ([9787af0](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/9787af025a3abc8cfd5c50f14182c98c85a0cf36))
* **tools:** restrict file downloads to portal file links ([c1364af](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/c1364afce0f6406d09874ce9a0457fd127182af1))


### Code Refactoring

* remove action catalog and traffic capture pipeline ([67638cd](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/67638cde118f8c5bd23c4533f225d7ed9b935a93))

## [0.5.0](https://github.com/DarWiM/bitrix24-mcp-bridge/compare/bitrix24-mcp-bridge-v0.4.0...bitrix24-mcp-bridge-v0.5.0) (2026-10-01)


### Features

* **tools:** read legacy task comments ([c9f2894](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/c9f28943276323b310b85fe8cb4391534d72b677))

## [0.4.0](https://github.com/DarWiM/bitrix24-mcp-bridge/compare/bitrix24-mcp-bridge-v0.3.0...bitrix24-mcp-bridge-v0.4.0) (2026-07-27)


### Features

* **bridge:** add text and binary response modes ([2fdf00b](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/2fdf00b8fb57378261a08c46d991af4283ef09aa))
* **catalog:** deliver new package entries into an installed catalog ([82e87e1](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/82e87e1d882a02110558206db06722e414034f87))
* **setup:** refresh the extension on upgrade and flag a stale one ([f2c89a5](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/f2c89a5c61c0df6bd5bb5f24aaa7f4ab702cc4f4))
* **tools:** read call analysis and download portal files ([d673f28](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/d673f280f7915f6112dc76d658119a610f5870b6))


### Bug Fixes

* **bridge:** decode utf-8 across socket chunk boundaries ([f8a8528](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/f8a85289d84621a0f5e6ffe1caf11ac78aeeb808))
* **tools:** correct the task list pagination and status hints ([38900e5](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/38900e516c2acd1f616868d324dd88ec43743f08))

## [0.3.0](https://github.com/DarWiM/bitrix24-mcp-bridge/compare/bitrix24-mcp-bridge-v0.2.1...bitrix24-mcp-bridge-v0.3.0) (2026-07-20)


### Features

* **tools:** add bitrix_entity_chat — resolve a linked object's chat by entity ([07f843e](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/07f843ec0be7d9335dd6e565dea5bdbe17d6fd98))
* **tools:** sharpen agent guidance for chats, task filtering, task-chat resolver ([c4a5079](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/c4a5079585376347f26f0bc7a03076ecaa1b2151))


### Bug Fixes

* **build:ext:** resolve token/origin/port via shared config, no dev token ([0752625](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/0752625b427becd6cf3414193647c804c1cd0b92))
* **extension:** sync manifest version with package.json ([7ab6310](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/7ab6310c13d62cf7f3f026a4bf8e47cdd27cc9be))

## [0.2.1](https://github.com/DarWiM/bitrix24-mcp-bridge/compare/bitrix24-mcp-bridge-v0.2.0...bitrix24-mcp-bridge-v0.2.1) (2026-07-20)


### Miscellaneous Chores

* release 0.2.1 ([4c53f91](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/4c53f91238f3721bc69197d0929b98c6b04b8c57))

## [0.2.0](https://github.com/DarWiM/bitrix24-mcp-bridge/compare/bitrix24-mcp-bridge-v0.1.1...bitrix24-mcp-bridge-v0.2.0) (2026-07-20)


### Features

* add catalog:draft / catalog scripts to run reconnaissance from repo root ([789a875](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/789a875b51eb80dc363979e56493ef4a1ebbc4bd))
* **bridge:** daemon — UDS server, singleton reserve, idle-exit ([d870a38](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/d870a3842444f529c53ea3934a811eaceb33b557))
* **bridge:** daemon answers a status frame with per-portal connection state ([f92c3e1](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/f92c3e1ffc99bc1b35e81e38ea1dce8a63e54d8b))
* **bridge:** graceful shutdown frame + expose actual bound port ([4a24a42](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/4a24a421c13a079a0a0baab8af2920211588ed1f))
* **bridge:** newline-JSON stream framing ([c3a58db](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/c3a58db0e37ed8b8ae476806fd0e0fa38b4b3bce))
* **bridge:** origin allow-set + origin-keyed call routing ([2ee5da4](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/2ee5da4728282ad372e2cac3532688c415ad010e))
* **bridge:** requestDaemonShutdown helper + persistent UDS error guard ([9fa2bcf](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/9fa2bcf224e33fc9edbc8aa074e644abb1892212))
* **bridge:** UDS client with connect-or-spawn-daemon ([4e32895](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/4e328957da39fb896505f19fe6aa5e0b935b9216))
* **bridge:** UdsClient.status() round-trip over the UDS frame protocol ([479d44e](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/479d44ec397e6f4ef9759ba4fa271e2dab319d67))
* **build-catalog:** accumulate unique param combinations into the draft ([8ddd7ce](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/8ddd7ce7ca001af7cda5b0bb74eb88c45e8d0ab9))
* **build:ext:** mark capture builds with a [CAPTURE] name suffix ([0d276bf](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/0d276bf1f9b9c0bb8f06a7fdcc79da166da41a94))
* capture mode — extension records API calls, recorder writes actions.draft.json ([e147271](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/e1472718ee08e3b0931b1895ae555ebce08a0372))
* **capture-server:** accumulate unique param combinations into the draft ([eb64dd7](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/eb64dd7d3a13a29bb5a622dbd2061db84e44b623))
* **capture:** tag bodyType and capture JSON bodies as nested params ([757f569](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/757f569fe0da25f7baf25202218cc1873c560242))
* catalog loader (allowlist) carrying full CallTarget per entry ([c93e403](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/c93e4030f33a5f635c181e50dc581bc5963f223e))
* **catalog:** draft accumulator for unique param combinations ([ba92210](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/ba92210f709ecba42cd37e5ff09cdcd08d0a5fef))
* **catalog:** drop read-only guard, carry bodyType (allowlist stays) ([95ae781](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/95ae781da8d7c090f728752e526feeb68a459856))
* **config:** add non-throwing loadConfigState for unconfigured startup ([743b510](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/743b51071c806b55985df686282749237d75a738))
* **config:** layered config.json + portals map (keeps bitrixOrigin) ([77483a2](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/77483a204d3f706a2f412f92b745797a4e2a0f82))
* **config:** runtime paths for ~/.bitrix24-mcp-bridge ([74bf0b3](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/74bf0b3c65d89d6e13473709b78d575efcc6959c))
* curate + typed-wrap 8 new catalog methods: ([b9539a8](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/b9539a8bb129166da0a27a7ca6d1980dbf5d9801))
* env-driven config via gitignored .env (server + extension build) ([015ea83](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/015ea83da074961a278697e12e2953e7dcf1e76c))
* **extension:** JSON body + X-Bitrix-Csrf-Token header for write calls ([d48cb91](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/d48cb91b571f8bb417a2bc4d4aa61a9a4dccf128))
* **extension:** pure config-parse + sessid postMessage protocol (TDD) ([1e04218](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/1e04218dceaabee6411ae461f12907795a931b5f))
* **extension:** split into ISOLATED connector + MAIN sessid shim; config-driven build ([e14d8d1](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/e14d8d1a8181e9900dfc52194dc2d6baa09c00a2))
* **har-parse:** read JSON text bodies and tag bodyType ([fa6d6ce](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/fa6d6cea914830d3576418bd1f3e63775607905a))
* mcp entrypoint + bitrix_call generic tool ([9de19cf](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/9de19cfe477b017b03de5025c5878d6937621a15))
* **mcp:** self-describing server — bitrix_help tool + bitrix://api-notes resource ([6b0e2cd](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/6b0e2cd48752d747230a7b605d4f84eb97901cbb))
* **mcp:** split entrypoint into daemon and stdio client modes ([86960bf](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/86960bf060520bfdced8696f44c6651346667143))
* **mcp:** start unconfigured — expose help+status and guide to setup ([0dd2a3f](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/0dd2a3f3f431e9ffe5164db85a312c1df642ce2d))
* MV3 extension — builds from single core via esbuild, parses bitrix errors ([e1a16a2](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/e1a16a2c0a437b26bc1d7829187a7a489a7bbf98))
* reconnaissance — broad HAR capture with triad coverage warnings ([e8da32a](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/e8da32a9a650ef5c59fb896ca468083aea80d345))
* **setup:** add config-core server config model and immutable mutators ([ddac6cd](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/ddac6cdca1ca8c34d4c8fafd96e995cc54e46303))
* **setup:** add edit-portal command to change an existing portal's origin ([be2bd84](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/be2bd846371957f39232f442cd1003e11e1118c4))
* **setup:** add interactive console setup and route the setup subcommand ([ee617ff](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/ee617ff87b6d6a0b891f3ec4bfc0fcc1996afe63))
* **setup:** add pure applySetupCommand reducer for the console menu ([4f1f07c](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/4f1f07cc54050eae53c881f26e27e7ad22df106d))
* **setup:** materialize extension with programmatic multi-origin manifest ([9f7be46](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/9f7be46879cf8c91a7386f1ae61282e728507e59))
* **setup:** restart the daemon after an effectful config change ([00a8371](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/00a8371c1f05a0cc46fee35fa7ecf91014ba73fc))
* **shared:** parseBody — nested JSON vs flat form body parsing ([aacac1c](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/aacac1cc6931d80e4feb3305f2d5d7c4a8852a9a))
* **tools:** add read-only bitrix_status reporting portal connection state ([1ff3014](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/1ff30146e96fba0dc33c974968039d08ecf68fad))
* **tools:** add v2 recent, search, relations, user tools ([eac77b8](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/eac77b8227f2f587d8ba4f5c9ccf8492e9562303))
* **tools:** controllable selections — params passthrough + smart defaults ([635784b](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/635784b274bdea50ec88531217905ac3154561de))
* **tools:** integrate new-capture methods + fix v2 task id shape ([b9539a8](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/b9539a8bb129166da0a27a7ca6d1980dbf5d9801))
* **tools:** route calls through a portal-aware CallSink ([c947b70](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/c947b70cda4f2777ec845c71c3f2903e3a403914))
* **tools:** typed wrappers for v2 tasks + chat scenarios ([1f87d14](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/1f87d1442ae3ff159ecbb997389e94b25c7b6343))
* typed read tools for triad with chat pagination + default limit ([9d0f71d](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/9d0f71da463814f2d57d05393f6397a9aea16241))
* **wire:** thread bodyType through CallTarget and the daemon ([7e55ffb](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/7e55ffb0e8e73ac6af799f99a14ab109be770a6e))
* ws bridge with connection registry and CallTarget protocol ([2609e46](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/2609e4625bc573acec2b46942e75f4f7ddf3a6d9))


### Bug Fixes

* **bridge/daemon:** flush shutdown ack via write callback, not setImmediate ([c670348](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/c67034878e40f61a4445e7a6040ea5bebb7f8d26))
* **bridge/uds-client:** requestDaemonShutdown only succeeds on a matched ack ([648a4a2](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/648a4a27919401ed54002cca4d5215e3bad3576e))
* **bridge:** add per-request timeout and clear socket ref on close in UdsClient ([48c1aa9](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/48c1aa9b48f8379808aabeaac7bb151134d15c26))
* **bridge:** create UDS socket dir before listen in daemon start ([efa3668](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/efa366813278045780c1f3e2c68141f6202507f3))
* **bridge:** enforce 0600 on UDS socket; validate portal origin ([4cfc497](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/4cfc4972261eb17c8dd761db6963eccac1f61e91))
* **bridge:** guard idle timer after stop; rollback partial daemon init ([ea0f47a](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/ea0f47a3f3a844e130617cd08c080e2cdc88cee3))
* **bridge:** port-gated daemon singleton; harden UDS parsing; test idle-exit ([327ab5c](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/327ab5c8e25289bc94a270cdef3e490228be506c))
* **bridge:** reject call on send failure; verify auth in tests ([3e70fc2](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/3e70fc2bcaffe5d264e0dc12815d7fde6d5ccbd3))
* **bridge:** stop() never rejects so floating idle/shutdown calls can't unhandled-reject ([5bba3dd](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/5bba3dde147039f4a4f0969c15b9d89e68b55af9))
* **config:** default catalog path to runtime home, not package root ([2aa7d11](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/2aa7d113498e8e6fd00e3f2e43dc8e63a58eefc9))
* **dist:** polyfill require via createRequire for ESM+CJS builtin interop ([fbb90ed](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/fbb90ed09084604a4820c9b775384ed240acae86))
* **extension:** treat empty errors[] in ajax success responses as success ([cc12944](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/cc12944d51b6998f7bc7bdc132330a9e812453ce))
* **extension:** use_dynamic_url for config.json; harden WS parse + port validation ([f68e6c1](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/f68e6c150a6c799c8669c812998bfef0982ad6d2))
* final-review bundle — reject on bind error, origin check, catalog denylist ([53d6525](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/53d652518a7e4b8e9a4beaec12f1f75348b52815))
* **mcp:** make server robust to spawn cwd, PATH, and stale port ([1fd9198](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/1fd9198fc085799efe7ca2f681d092ba876c31f5))
* reject prototype-chain names in catalog allowlist ([8343022](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/83430227206a445f1268c6b5dc0a8593d20b96f6))
* robust triad coverage detection via token matching ([9ce7fb3](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/9ce7fb3408c58efbfcd67acde8bce4e13f8d1481))
* **setup:** don't claim the daemon stopped when no ack was received ([5c44ddf](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/5c44ddf28de823ba8738a2f4816d4ef31d455c1a))
* **setup:** re-prompt on invalid/empty portal origin instead of crashing ([b5794e0](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/b5794e0bfa2d4470b0bc8d0ca5aff5533b6eba7f))
* **setup:** tighten portal origin validation to true origins only ([8e59878](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/8e598782727ce6da5afb4ff69551d43456159f86))
* tasks.v2.Task.get / Task.View.User.count take the id NESTED as ([b9539a8](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/b9539a8bb129166da0a27a7ca6d1980dbf5d9801))
* **tools:** drop non-working backward paging from bitrix_chat_messages ([6edc94f](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/6edc94ff3336f7b572962236b95cb5527507bd61))
* **tools:** map bitrix_chat_messages to im.v2 params (chatId/limit/filter[lastId]) ([164bb63](https://github.com/DarWiM/bitrix24-mcp-bridge/commit/164bb63d07bbc7d9795b5dd376f2a8516f1ed1b2))
