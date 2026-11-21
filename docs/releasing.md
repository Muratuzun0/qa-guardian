# Publishing QA Guardian

The package name is `qa-guardian`. The [Publish to npm workflow](../.github/workflows/publish.yml) runs on GitHub-hosted runners. It tests the CLI and uploads the same tarball that the package smoke test installed. A push that changes release configuration only builds the artifact. To publish through OIDC, manually run the workflow on `main` with its **publish** input enabled. The job that installs dependencies, builds, and tests has read-only GitHub permissions. Only the separate publish job can request an OIDC token.

## First publication

npm configures trusted publishers in an existing package's settings. If the package does not exist yet, bootstrap with an authenticated npm account using 2FA. Download the `npm-package` artifact from the workflow run for the intended release commit and extract `qa-guardian.tgz`. On a trusted terminal, with Node.js 24 and npm 11.15.0 or newer, use web login and stage the tested archive.

```sh
npm login --auth-type=web --registry https://registry.npmjs.org
npm whoami --registry https://registry.npmjs.org
npm stage publish ./qa-guardian.tgz --access public --registry https://registry.npmjs.org
```

Review the name and version in **Staged Packages** on npmjs.com and approve with 2FA. This publishes the staged version. A version already published this way cannot be published again through OIDC. Use a newer version for the first OIDC publication. [npm staged publishing](https://docs.npmjs.com/staged-publishing/)

## Configure npm Trusted Publishing

On npmjs.com, open **Packages → qa-guardian → Settings → Trusted publishing**, then choose **GitHub Actions**.

| Setting | Value |
| --- | --- |
| Organization or user | `Muratuzun0` |
| Repository | `qa-guardian` |
| Workflow filename | `publish.yml` |
| Environment name | Leave blank |
| Allowed actions | Enable `npm publish`. Dist-tag management is unnecessary. |

Create the trusted publisher when the next unpublished version is ready. npm gives new configurations two days to complete their first successful publish. Once OIDC publishing works, npm recommends requiring 2FA and disallowing publishing tokens in the package settings. [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)

After publication, install the exact registry version into a clean temporary project and run `qa-guardian --version` and `qa-guardian --help` through the installed binary. Create the matching GitHub tag and release only after registry verification, and point the tag at the commit that produced the package.
