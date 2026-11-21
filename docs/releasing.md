# Publishing QA Guardian

The package name is `@muratuzun0/qa-guardian`. The [Publish to npm workflow](../.github/workflows/publish.yml) runs on GitHub-hosted runners. It tests the CLI and uploads the same tarball that the package smoke test installed. A push that changes release configuration only builds the artifact. To publish through OIDC, manually run the workflow on `main` with its **publish** input enabled. The job that installs dependencies, builds, and tests has read-only GitHub permissions. Only the separate publish job can request an OIDC token.

## First publication

npm configures trusted publishers in an existing package's settings. If the package does not exist yet, bootstrap with an authenticated npm account using 2FA. Download the `npm-package` artifact from the workflow run for the intended release commit and extract `muratuzun0-qa-guardian.tgz`. On a trusted terminal with Node.js 24, sign in as `muratuzun0`, confirm the account, and publish the tested archive with public access. Complete any approval requested by npm in your browser.

```sh
npm login --auth-type=web --registry https://registry.npmjs.org
npm whoami --registry https://registry.npmjs.org
npm publish ./muratuzun0-qa-guardian.tgz --access public --registry https://registry.npmjs.org
```

Use a newer version for the first OIDC publication. [npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/)

## Configure npm Trusted Publishing

On npmjs.com, open **Packages → @muratuzun0/qa-guardian → Settings → Trusted publishing**, then choose **GitHub Actions**.

| Setting | Value |
| --- | --- |
| Organization or user | `Muratuzun0` |
| Repository | `qa-guardian` |
| Workflow filename | `publish.yml` |
| Environment name | Leave blank |
| Allowed actions | Enable `npm publish`. Dist-tag management is unnecessary. |

Create the trusted publisher when the next unpublished version is ready. npm gives new configurations two days to complete their first successful publish. Once OIDC publishing works, npm recommends requiring 2FA and disallowing publishing tokens in the package settings. [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)

After publication, install the exact registry version into a clean temporary project and run `qa-guardian --version` and `qa-guardian --help` through the installed binary. Create the matching GitHub tag and release only after registry verification, and point the tag at the commit that produced the package.
