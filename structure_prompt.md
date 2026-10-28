# Mission: Professionally Refactor My AI Companion Desktop Application

Act as a senior software architect and Rust + TypeScript + Tauri engineer.

I am building a Windows desktop AI companion application called **Ei Waifu**. The project uses Rust, TypeScript, Tauri, local AI models, character assets, and Windows scripts.

My goal is to turn the existing codebase into a clean, modular, maintainable, production-ready application that can eventually be distributed commercially and potentially published on Steam.

## 1. First: Audit the Existing Project

Before modifying anything:

- Inspect the entire repository and identify the current architecture.
- Read `package.json`, `Cargo.toml`, Tauri configuration, README, scripts, and relevant source files.
- Identify the frontend framework, build system, Rust responsibilities, AI runtime, model-loading logic, character rendering, state management, and persistence.
- Identify duplicated code, oversized files, circular dependencies, unused code, insecure patterns, inconsistent naming, and fragile Windows scripts.
- Determine which features currently work and how the application starts and stops.
- Identify existing tests and available build commands.
- Write a concise refactoring plan with risks and proposed file changes.

Do not assume the project uses a particular framework or that every suggested directory already exists. Adapt to the actual repository.

## 2. Target Architecture

Refactor toward the following logical structure where appropriate. Preserve framework-specific conventions and avoid creating unnecessary abstractions.

```text
denis_companion_agent/
├── assets/
│   ├── characters/
│   ├── animations/
│   ├── outfits/
│   ├── emotions/
│   └── icons/
├── public/
├── models/
│   └── README.md
├── src/
│   ├── app/
│   ├── components/
│   │   ├── character/
│   │   ├── chat/
│   │   ├── settings/
│   │   └── common/
│   ├── features/
│   │   ├── companion/
│   │   ├── conversation/
│   │   ├── memory/
│   │   └── model-manager/
│   ├── hooks/
│   ├── services/
│   │   ├── ai/
│   │   ├── storage/
│   │   └── desktop/
│   ├── stores/
│   ├── types/
│   ├── utils/
│   └── styles/
├── src-tauri/
│   ├── src/
│   │   ├── commands/
│   │   ├── services/
│   │   ├── ai/
│   │   ├── storage/
│   │   ├── errors/
│   │   ├── state.rs
│   │   └── lib.rs
│   ├── capabilities/
│   ├── icons/
│   ├── Cargo.toml
│   └── tauri.conf.json
├── tools/
│   └── scripts/
├── tests/
├── docs/
├── .github/
│   └── workflows/
├── .gitignore
├── .env.example
├── package.json
├── README.md
└── LICENSE
```

This is a target for logical organization, not a requirement to create every directory. Use the existing framework, current Tauri version, and actual application requirements.

## 3. Frontend Engineering

- Separate UI components, application features, business logic, and external services.
- Keep components small and focused on one responsibility.
- Extract duplicated logic into reusable functions, hooks, or services where appropriate.
- Use strict TypeScript types; avoid `any` unless justified.
- Centralize shared types, configuration, and error handling.
- Keep AI requests and desktop API calls out of presentation components.
- Preserve existing animations, character interactions, outfits, emotions, chat, settings, and window behavior.
- Implement consistent loading, error, empty, and offline states.
- Remove dead code and dependencies only after verifying they are genuinely unused.

Do not introduce a new frontend framework or state-management library without a concrete reason.

## 4. Rust and Tauri Engineering

- Separate Tauri commands from application services and low-level integrations.
- Keep `main.rs` minimal and follow the conventions of the current Tauri version.
- Use typed request and response structures for frontend/backend communication.
- Return useful, consistent errors instead of silently swallowing failures.
- Use appropriate asynchronous operations for long-running tasks.
- Avoid blocking the UI thread during model loading, inference, or file operations.
- Manage shared state safely and avoid unnecessary locks.
- Restrict filesystem access and Tauri capabilities to what the application actually needs.
- Never expose arbitrary shell execution or unrestricted filesystem access to the frontend.
- Avoid duplicating business logic between TypeScript and Rust.

Preserve all working IPC commands and update their callers when a deliberate API change is necessary.

## 5. Local AI Architecture

Create a clear separation between the companion application and its AI runtime.

- Encapsulate model discovery, model configuration, loading, inference, unloading, and runtime health checks.
- Use a provider or adapter interface only where it makes the existing implementation easier to maintain or extend.
- Keep model paths configurable and validate them before use.
- Handle missing models, corrupted downloads, incompatible hardware, insufficient memory, and runtime failures gracefully.
- Do not load large models unnecessarily at application startup.
- Keep model files out of Git unless the project explicitly requires small, licensed assets to be version-controlled.
- Document model acquisition, storage, hardware requirements, and license restrictions.
- Preserve local-first functionality and do not introduce a cloud dependency.

Do not replace the current AI engine unless the existing implementation is demonstrably unsuitable and the change is explicitly justified.

## 6. Security and Privacy

- Do not commit API keys, tokens, passwords, private certificates, or personal conversation data.
- Create or update `.env.example` with placeholder values only when environment variables are actually needed.
- Keep user data in an appropriate application-data directory rather than writing to arbitrary project locations.
- Review file operations, process launching, input validation, model downloads, and frontend-to-Rust permissions.
- Do not delete existing user data or reset user settings during refactoring.
- Do not add analytics, telemetry, network services, or data collection without explicit justification.

## 7. Windows Release and Distribution

Prepare the architecture for a reliable Windows release.

- Verify the current Tauri bundling configuration and Windows build prerequisites.
- Organize development, testing, and release scripts under `tools/scripts/` when appropriate.
- Replace fragile hard-coded paths with configurable or repository-relative paths.
- Make startup and shutdown reliable and avoid orphaned model processes.
- Document whether the runtime and model are bundled or installed separately.
- Provide clear model setup and troubleshooting instructions.
- Review Windows installer configuration, application metadata, icons, and versioning.
- Document how to create a release build and verify it on a clean Windows environment.

Do not claim Steam compatibility or create Steam-specific packaging until the application type and publishing requirements have been verified.

## 8. Documentation and Code Quality

Update the documentation to include:

- Project overview and architecture.
- Prerequisites and development setup.
- Installation and launch instructions.
- Local AI model setup.
- Configuration and environment variables.
- Testing and production build commands.
- Windows packaging instructions.
- Troubleshooting and known limitations.
- Third-party dependency and model licensing notes.

Use consistent naming, formatting, linting, and error-handling conventions. Add tests for important business logic and Rust services where practical.

## 9. Refactoring Workflow

Work incrementally and safely.

Phase A: Audit the existing repository and report findings.

Phase B: Propose the final architecture and migration plan.

Phase C: Refactor the frontend and Rust backend in small, logically grouped changes.

Phase D: Update configuration, scripts, tests, and documentation.

Phase E: Run the available formatter, linter, type checker, tests, and production build. Fix regressions caused by your changes.

Phase F: Report the final architecture, changed files, commands executed, test results, remaining issues, and instructions for producing a Windows release.

After each major phase, summarize the changes and verification results.

## 10. Non-Negotiable Rules

- Do not delete or replace the project with a new starter template.
- Do not remove existing features to make the architecture look cleaner.
- Do not rewrite the entire application in one operation.
- Do not change the frontend framework, Tauri version, AI engine, or major dependencies without justification.
- Do not fabricate test results or claim a build succeeded unless it actually succeeded.
- Do not move or rename files without updating all relevant imports, configuration references, scripts, and documentation.
- Do not overwrite user data, model files, or uncommitted work.
- Inspect Git status before changes and preserve unrelated modifications.
- Use the smallest reasonable changes that achieve a maintainable architecture.
- If a change is risky or ambiguous, explain the trade-offs before proceeding.
- If tests fail, distinguish pre-existing failures from regressions caused by your changes.

Start with Phase A only. Inspect the repository and report your findings and proposed plan before making destructive or broad changes.