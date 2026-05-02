import * as vscode from 'vscode';

const HEALTH_ENDPOINT = '/api/v1/health';
const POLL_PORTS = Array.from({ length: 11 }, (_, i) => 3000 + i);

async function findRunningServer(preferredPort: number): Promise<number | null> {
  const portsToTry = [preferredPort, ...POLL_PORTS.filter(p => p !== preferredPort)];

  for (const port of portsToTry) {
    try {
      const http = await import('http');
      const result = await new Promise<boolean>((resolve) => {
        const req = http.get(`http://localhost:${port}${HEALTH_ENDPOINT}`, (res) => {
          resolve(res.statusCode === 200);
          res.resume();
        });
        req.on('error', () => resolve(false));
        req.setTimeout(1000, () => { req.destroy(); resolve(false); });
      });
      if (result) return port;
    } catch {
      // continue
    }
  }
  return null;
}

class InterveilViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _port: number | null = null;
  private _pollInterval?: ReturnType<typeof setInterval>;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    this._updateView();
    this._startPolling();

    webviewView.onDidDispose(() => this._stopPolling());
  }

  private _startPolling() {
    this._pollInterval = setInterval(() => this._checkAndUpdate(), 3000);
  }

  private _stopPolling() {
    if (this._pollInterval) clearInterval(this._pollInterval);
  }

  private async _checkAndUpdate() {
    const config = vscode.workspace.getConfiguration('interveil');
    const preferredPort = config.get<number>('port', 3000);
    const newPort = await findRunningServer(preferredPort);

    if (newPort !== this._port) {
      this._port = newPort;
      this._updateView();
    }
  }

  private async _updateView() {
    if (!this._view) return;
    const config = vscode.workspace.getConfiguration('interveil');
    const preferredPort = config.get<number>('port', 3000);

    if (this._port === null) {
      this._port = await findRunningServer(preferredPort);
    }

    if (this._port) {
      this._view.webview.html = this._getIframeHtml(this._port);
    } else {
      this._view.webview.html = this._getOfflineHtml();
    }
  }

  private _getIframeHtml(port: number): string {
    return `<!DOCTYPE html>
<html style="height:100%;margin:0;padding:0;">
<head>
  <meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline' 'unsafe-eval'; frame-src *;">
  <style>
    html, body, iframe { height: 100%; width: 100%; margin: 0; padding: 0; border: none; }
    body { overflow: hidden; }
  </style>
</head>
<body>
  <iframe src="http://localhost:${port}" frameborder="0" width="100%" height="100%"></iframe>
  <script>
    window.addEventListener('message', e => {
      const iframe = document.querySelector('iframe');
      if (iframe && iframe.contentWindow) iframe.contentWindow.postMessage(e.data, '*');
    });
  </script>
</body>
</html>`;
  }

  private _getOfflineHtml(): string {
    return `<!DOCTYPE html>
<html>
<head>
  <style>
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0F172A;
      color: #94A3B8;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
      text-align: center;
      gap: 16px;
    }
    .icon { font-size: 40px; opacity: 0.4; }
    .title { color: #F1F5F9; font-size: 16px; font-weight: 600; }
    .sub { font-size: 12px; line-height: 1.6; }
    a { color: #3B82F6; text-decoration: none; }
    code {
      background: #1E293B;
      padding: 2px 6px;
      border-radius: 4px;
      font-family: monospace;
      font-size: 11px;
      color: #34D399;
    }
  </style>
</head>
<body>
  <div class="icon">◎</div>
  <div class="title">Start Interveil to see traces here</div>
  <div class="sub">
    Run <code>interveil serve</code> in your terminal,<br>
    then this panel will automatically connect.<br><br>
    <a href="https://github.com/interveil/interveil">Documentation ↗</a>
  </div>
</body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new InterveilViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('interveil.traceView', provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('interveil.openPanel', () => {
      vscode.commands.executeCommand('interveil.traceView.focus');
    })
  );
}

export function deactivate() {}
