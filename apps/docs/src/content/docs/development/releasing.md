---
title: Releasing
description: How a uShelf release is cut and published.
---

Run the **Release** workflow manually with the desired semantic version. The workflow opens a `release/vMAJOR.MINOR.PATCH` pull request containing the project-version updates.

Merging that pull request verifies the merged commit, creates its version tag, publishes the CLI archives and the container image, and creates the GitHub Release. Do not create the release tag beforehand.

The CLI and the container image share a version. Each CLI release deploys the image with the same version unless a context pins another image.
