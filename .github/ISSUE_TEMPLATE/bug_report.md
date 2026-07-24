---
name: Bug report
about: Something isn't working as expected
title: "[bug] "
labels: bug
body:
  - type: textarea
    id: what-happened
    attributes:
      label: What happened?
      description: A clear description of the unexpected behavior.
      placeholder: "When I ran `npm start`, the server..."
    validations:
      required: true
  - type: textarea
    id: reproduce
    attributes:
      label: Steps to reproduce
      description: Minimal steps to trigger the bug.
      placeholder: "1. ...\n2. ..."
    validations:
      required: true
  - type: input
    id: os
    attributes:
      label: OS
      placeholder: "Windows 11 / macOS 14 / Ubuntu 24.04"
    validations:
      required: true
  - type: input
    id: node
    attributes:
      label: Node.js version
      placeholder: "node --version"
    validations:
      required: true
  - type: input
    id: vibe
    attributes:
      label: tokenflare version
      placeholder: "1.0.0"
    validations:
      required: true
  - type: textarea
    id: logs
    attributes:
      label: Relevant logs
      description: Output from the server console, browser devtools, or hook shim. Paste between triple backticks.
      render: shell
---

<!-- Before opening a bug, please check existing issues and the Troubleshooting section of the README. Thanks! -->
