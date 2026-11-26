# Deploy Drawplate

## GitHub Pages

1. Push this directory as the root of the `drawplate` repository on GitHub.
2. Open **Settings → Pages → Build and deployment** and set **Source** to **GitHub Actions**.
3. Run **Deploy Drawplate to GitHub Pages** from **Actions**, or push a commit to `main`. Open the URL reported by the `github-pages` environment and follow **Try the workbench**. For `aarushvan/drawplate`, the default URL is `https://aarushvan.github.io/drawplate/`.

The static workbench runs all five tools in the browser. Cadastre loads its bundled code index and Tapeline loads its bundled cassette pair. Serve over HTTPS for AudioWorklet. Subpass profiling requires WebGL2.

[GitHub Pages source settings](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

## Optional Node API

Run the container locally to verify the workbench and API together.

```bash
docker build --tag drawplate .
docker run --rm -p 127.0.0.1:8080:8080 drawplate
```

Open `http://127.0.0.1:8080/workbench.html` and check `http://127.0.0.1:8080/api/health` for `"ok": true`. The container runs as the unprivileged `node` user and uses a writable `.drawplate` directory. The server indexes its bundled source on startup, so the SQLite index can be rebuilt on each deployment.

- **Fly.io**. Create a Fly app with `fly apps create` and put the assigned name in `fly.toml` if it differs from `drawplate`. Run `fly deploy` from the repository root. The config uses port 8080 and waits for `/api/health`.
- **Render**. In the Render dashboard, create a **Blueprint** from the repository. It reads `render.yaml`, builds the Dockerfile, and uses `/api/health` for readiness.
- Open the workbench served by the Node deployment to use the live API. The GitHub Pages version uses its bundled index.

[Fly CLI](https://fly.io/docs/flyctl/) · [Render Blueprint reference](https://render.com/docs/blueprint-spec)

## Custom domain and HTTPS

In the GitHub Pages settings, set **Custom domain** and add the DNS records GitHub specifies. Verify the domain in GitHub and turn on **Enforce HTTPS** once the certificate is ready. For a Node deployment, add the domain through Fly.io or Render and follow its DNS and certificate instructions.

[GitHub Pages custom domains](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)
