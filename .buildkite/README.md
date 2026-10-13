# wave-bridge-edge on Buildkite (shadow mode)

This directory ports wave-bridge-edge's credential-free GitHub Actions gates to Buildkite, following the
wave-ci migration plan (wave-av/wave-ci#59). Nothing under `.github/` changes. The GitHub workflows stay
the gate until the Buildkite pipeline has been green for 7 consecutive days. No Buildkite pipeline exists
for this repository yet; creating one is an operator step (see "Fork pull requests").

## Fork pull requests

This is a public repository, so anyone can open a pull request from a fork. **Fork pull requests are
refused by the pipeline setting `build_pull_request_forks: false`: Buildkite never starts a build for
them, so fork code never runs on these CI agents.** The setting is applied and verified by wave-ci's
pipeline wrapper, RUN-229, which sends `build_pull_request_forks: false` for every pipeline it creates
and fails its verification if the live pipeline says otherwise.

Two more fences stand behind that setting. The pipeline renderer refuses a fork pull request without the
`ci:approved` label, and for an approved one it drops every step that would receive a secret. No step in
this file receives a secret anyway (see "Credentials").

## Layout

| path | role |
|---|---|
| `pipeline.yml`, `wave-ci.sh` | The wave-ci thin uploader and the fixed shim, byte-identical to wave-ci's `repo-kit/.buildkite/` at the pin. Do not edit. |
| `wave-ci.json` | The settings the uploader renders: template `custom`, `wave_ci` pinned to 296cc0cf4faf1f06d0acd4c2a767d6c111d2adf3, 4 steps. |
| `wave-ci.deferred.json` | NOT rendered. Every GitHub job with no running step yet, with the reason and the blocker (`parked_jobs`). |
| `scripts/<step>.sh` | One script per Buildkite step. Each checks its tools, runs its gates and prints a summary. |
| `scripts/lib/common.sh` | Strict mode, credential hygiene, the gate runner and the summary. |
| `gates/*.gate` | The VERBATIM `run:` bodies of the GitHub steps being replaced, named `<workflow>.<job>.<nn>-<step>.gate` (go-lint adds the matrix cell: `go-lint.go-lint.<cell>.<nn>-<step>.gate`). |

## Why the gates are copies

A gate that runs the same bytes as the GitHub step is a parity claim anyone can check. Each file header
names the workflow, job and step it came from and the commit it was copied at (698f7f7509c9). The runner
executes it as `bash -e <file>`, GitHub's default shell, in the step's `working-directory` (`#
gh-working-directory:`, the matrix value for go-lint) with the step's literal `env:` (`# gh-env:
NAME=value`; image-content-gate's job-level env). To refresh one, copy the step's `run:` body from the
workflow unchanged. A failing gate does not stop the others in its step: every gate runs, then the summary
fails the step if any blocking gate failed.

## Parity: every GitHub Actions job

| GH workflow / job | triggers | Buildkite | notes |
|---|---|---|---|
| `_checks.yml` / `checks` | called by foundation-gate | step `foundation-gate` | secret scan + file-size gate (max 800) |
| `_checks.yml` / `skill-validate` | called by foundation-gate | step `foundation-gate` | Python 3.12 + PyYAML, as on GitHub |
| `_checks.yml` / `verify-routes` | called by foundation-gate | step `foundation-gate` | URL convention gate on `wrangler.toml` |
| `foundation-gate.yml` / `gate` | PR, push main/master/staging, merge_group | step `foundation-gate` | the caller of the three jobs above |
| `public-repo-guard.yml` / `guard` | PR, push main/master, workflow_dispatch, merge_group | step `public-repo-guard` | gitleaks 8.30.1 + content policy |
| `go-lint.yml` / `go-lint` (matrix of 4) | PR; push to `master` (no such branch) | step `go-lint` (`pr_only`) | gofmt + go vet per adapter, the 4 cells in one guest |
| `image-content-gate.yml` / `ndi` | PR (paths), push main (paths), workflow_dispatch | step `image-content-gate` | `paths` + `paths_on_default_branch` mirror both path filters |
| `typecheck.yml` / `typecheck` | PR, push main | parked | private npm registry |
| `test.yml` / `test` | PR, push main | parked | private npm registry |
| `bundle-eval-gate.yml` / `bundle-eval` | PR, push (paths) | parked | private npm registry |
| `governance-enforce.yml` / `enforce` | PR, push, merge_group | parked | private npm registry |
| `ffmpeg-bench.yml` / `bench` | PR (paths) | parked | private-repo credential on PR builds; over the step cap |
| `ffmpeg-bench.yml` / `check-secret` | PR (paths) | parked | exists only to gate `bench` |
| `ffmpeg-bench.yml` / `warm-baseline-cache` | push main (paths) | parked | GitHub cache backend; nothing to warm on disposable guests |
| `deploy.yml` / `deploy` | push main (paths), workflow_dispatch | parked | deploy: waits for Jake to name it |
| `issue-ops-triage.yml` / `triage` | issues | parked | event bot |
| `pr-agent.yml` / `pr_agent` | PR, issue_comment | parked | event bot |

17 jobs: 7 ported into 4 steps, 10 parked. Nothing is dropped. No workflow here has a `schedule:` trigger.

## Parked jobs

Each is listed in `wave-ci.deferred.json` with its reason and blocker. The GitHub workflow stays the gate
for these meanwhile.

- **Private npm registry** (`typecheck`, `test`, `bundle-eval`, `enforce`). Every one installs private
  `@wave-av/*` packages (`spoke-chassis`, `container-pool`, `governance`) from GitHub Packages, which
  returns 403 (billing block). They will come from WAVE's self-hosted npm registry (ruling WGL-0928-18),
  which is in progress. No workaround is used here. When it lands, these become steps; each will need a
  registry read credential, which for a public repository is a decision for Jake.
- **ffmpeg-bench** (`bench`, `check-secret`, `warm-baseline-cache`). The tools are not the blocker: the
  CI image has Docker rootless with buildx, ffmpeg 6.1.1 and Go 1.27.1. `bench` checks out its harness
  from a private repository with `CONFORMANCE_REPO_PAT` on pull_request builds only, and posts a PR
  comment with a GitHub write token; a public repo's step may hold a secret only when it needs it on main,
  and this one never runs on main. Two cold source builds of ffmpeg also exceed the 60-minute step cap
  (GitHub allows 120). `warm-baseline-cache` only fills GitHub's layer cache, which has no counterpart on
  disposable guests. `check-secret` exists only to gate `bench`.
- **Deploy** (`deploy`). Not ported until Jake names the deploy.
- **Event bots** (`triage`, `pr_agent`). They react to GitHub events Buildkite does not receive (issues,
  comments) or write back to GitHub. They wait for the GitHub-event bridge, RUN-231 (wave-ci#132).

## Differences from GitHub, on purpose

- Tools come from the CI image, never from a download in the job: gitleaks 8.30.1 (the version GitHub
  pins; the step fails if the image has another), ripgrep with PCRE2, Python 3.12 and PyYAML, Go and
  Docker. The GitHub install steps (gitleaks download, `apt-get install ripgrep`, `pip install pyyaml`,
  `setup-go`) are therefore not copied. If the selected Python lacks PyYAML, the step installs it into a
  job-local venv from PyPI.
- `go-lint`: GitHub's `setup-go` resolves `stable` at run time; here the image's pinned Go runs, with
  `GOTOOLCHAIN=local` so a `toolchain` line can never trigger a download, and job-local build and module
  caches. The four matrix cells run in one guest, every cell even after a failure (GitHub used
  `fail-fast: false`). GitHub never runs go-lint on main (its push trigger names `master`, which does not
  exist), so the step is `pr_only`.
- `image-content-gate`: the build pulls its public base images (Docker Hub) from the guest; nothing is
  pushed, and the image is removed at the end. The scan gate runs only after a successful build, as on
  GitHub.
- `GUARD_PRIVATE_REPOS` is a GitHub organization variable, not a secret, and Buildkite cannot read it.
  Without it, `content-policy.sh` skips its private-name rule, exactly as it does on a developer machine;
  the step prints a warning. Every other content-policy rule runs. Restoring the rule needs the list
  delivered to the step, which is a decision for Jake (see the PR).
- `merge_group` has no Buildkite counterpart; merge-queue builds would be ordinary branch builds.
- `harden-runner` steps are dropped (the guest firewall replaces them); checkouts are the agent's.

## Credentials

No running step declares or receives a secret. `scripts/lib/common.sh` unsets every credential-shaped
name before any gate runs.

## Checking a change locally

With a checkout of wave-ci at the pinned commit (and `npm ci` in its `tools/caps-lint`):

```sh
node <wave-ci>/bin/wave-ci-render.mjs --settings .buildkite/wave-ci.json --context <ctx.json> --out-dir <empty dir>
node <wave-ci>/tools/caps-lint/bin/caps-lint.mjs <empty dir>/*.yml .buildkite
```

The step scripts refuse to run outside a Buildkite job (`BUILDKITE=true`).
