const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    // 1. Register the Sidebar Webview Provider
    const sidebarProvider = new SidebarProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            "laravelProjectCreator.sidebarView",
            sidebarProvider
        )
    );

    // 2. Register the command to open the Main Panel
    let openPanelCmd = vscode.commands.registerCommand('laravelProjectCreator.openPanel', () => {
        MainPanel.createOrShow(context.extensionUri);
    });
    context.subscriptions.push(openPanelCmd);
}

class SidebarProvider {
    constructor(extensionUri) {
        this._extensionUri = extensionUri;
    }

    resolveWebviewView(webviewView, context, token) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview();

        webviewView.webview.onDidReceiveMessage((data) => {
            switch (data.type) {
                case 'openPanel': {
                    vscode.commands.executeCommand('laravelProjectCreator.openPanel');
                    break;
                }
            }
        });
    }

    _getHtmlForWebview() {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Laravel Creator Sidebar</title>
            <style>
                body {
                    padding: 10px;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: flex-start;
                    height: 100vh;
                    font-family: var(--vscode-font-family);
                    color: var(--vscode-foreground);
                }
                h2 {
                    text-align: center;
                    font-size: 14px;
                    margin-bottom: 20px;
                }
                button {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 8px 12px;
                    width: 100%;
                    cursor: pointer;
                    font-size: 13px;
                    border-radius: 2px;
                }
                button:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
            </style>
        </head>
        <body>
            <h2>Laravel Creator</h2>
            <button id="createBtn">Create Project</button>

            <script>
                const vscode = acquireVsCodeApi();
                document.getElementById('createBtn').addEventListener('click', () => {
                    vscode.postMessage({ type: 'openPanel' });
                });
            </script>
        </body>
        </html>`;
    }
}

class MainPanel {
    static currentPanel = undefined;

    static createOrShow(extensionUri) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If we already have a panel, show it.
        if (MainPanel.currentPanel) {
            MainPanel.currentPanel._panel.reveal(column);
            return;
        }

        // Otherwise, create a new panel.
        const panel = vscode.window.createWebviewPanel(
            'laravelCreatorPanel',
            'Create Laravel Project',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri]
            }
        );

        MainPanel.currentPanel = new MainPanel(panel, extensionUri);
    }

    constructor(panel, extensionUri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        this._update();

        this._panel.onDidDispose(() => this.dispose(), null, []);

        this._panel.webview.onDidReceiveMessage(
            message => {
                switch (message.type) {
                    case 'createProject':
                        this._handleCreateProject(message.data);
                        return;
                }
            },
            null,
            []
        );
    }

    dispose() {
        MainPanel.currentPanel = undefined;
        this._panel.dispose();
    }

    _update() {
        this._panel.webview.html = this._getHtmlForWebview();
    }

    async _handleCreateProject(data) {
        const { projectName, dbUsername, dbPassword, dbHost, dbPort, dbName } = data;

        if (!projectName || !dbName || !dbUsername || !dbPassword) {
            vscode.window.showErrorMessage("Please fill all the required fields.");
            this._panel.webview.postMessage({ type: 'error', message: "Please fill all required fields." });
            return;
        }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showErrorMessage("Please open a workspace folder first to create a Laravel project.");
            this._panel.webview.postMessage({ type: 'error', message: "No workspace folder found." });
            return;
        }

        const workspacePath = workspaceFolders[0].uri.fsPath;
        const projectPath = path.join(workspacePath, projectName);

        // Notify UI that process started
        this._panel.webview.postMessage({ type: 'progress', message: 'Executing Composer Create-Project...' });

        // Let's spawn a process
        const isWin = process.platform === "win32";
        const cmd = isWin ? 'composer.bat' : 'composer';
        const args = ['create-project', 'laravel/laravel', `"${projectName}"`];

        vscode.window.showInformationMessage(`Creating Laravel project '${projectName}'...`);

        const composerProcess = cp.spawn(cmd, args, { cwd: workspacePath, shell: true });

        let outputData = '';

        composerProcess.stdout.on('data', (chunk) => {
            const out = chunk.toString();
            outputData += out;
            this._panel.webview.postMessage({ type: 'log', message: out });
        });

        composerProcess.stderr.on('data', (chunk) => {
            const errOut = chunk.toString();
            outputData += errOut;
            this._panel.webview.postMessage({ type: 'log', message: errOut });
        });

        composerProcess.on('error', (err) => {
            vscode.window.showErrorMessage(`Failed to start composer: ${err.message}`);
            this._panel.webview.postMessage({ type: 'error', message: `Composer error: ${err.message}` });
        });

        composerProcess.on('close', (code) => {
            if (code !== 0) {
                vscode.window.showErrorMessage(`Composer exited with code ${code}. Process failed.`);
                this._panel.webview.postMessage({ type: 'error', message: `Creation failed (Code: ${code}). See logs for details.` });
                return;
            }

            this._panel.webview.postMessage({ type: 'progress', message: 'Project created successfully. Updating .env file...' });

            try {
                this._updateEnvFile(projectPath, data);
                vscode.window.showInformationMessage(`Laravel project '${projectName}' created and configured successfully!`);
                this._panel.webview.postMessage({ type: 'success', message: 'Project Created & Configured Successfully!' });
            } catch (err) {
                vscode.window.showErrorMessage(`Could not update .env file: ${err.message}`);
                this._panel.webview.postMessage({ type: 'error', message: `Error updating .env: ${err.message}` });
            }
        });
    }

    _updateEnvFile(projectPath, data) {
        const envPath = path.join(projectPath, '.env');
        const envExamplePath = path.join(projectPath, '.env.example');

        // Note: composer create-project laravel/laravel already copies .env.example to .env
        // We will just wait for it, read .env, and update it.
        if (!fs.existsSync(envPath)) {
            if (fs.existsSync(envExamplePath)) {
                fs.copyFileSync(envExamplePath, envPath);
            } else {
                fs.writeFileSync(envPath, ''); // Fallback
            }
        }

        let envContent = fs.readFileSync(envPath, 'utf8');

        // Regex replacements
        envContent = envContent.replace(/^DB_CONNECTION=.*$/m, 'DB_CONNECTION=mysql'); // Fallback to mysql if it's sqlite
        envContent = envContent.replace(/^DB_HOST=.*$/m, `DB_HOST=${data.dbHost}`);
        envContent = envContent.replace(/^DB_PORT=.*$/m, `DB_PORT=${data.dbPort}`);
        envContent = envContent.replace(/^DB_DATABASE=.*$/m, `DB_DATABASE=${data.dbName}`);
        envContent = envContent.replace(/^DB_USERNAME=.*$/m, `DB_USERNAME=${data.dbUsername}`);
        envContent = envContent.replace(/^DB_PASSWORD=.*$/m, `DB_PASSWORD=${data.dbPassword}`);

        // If the variables didn't exist in the file, append them
        if (!/^DB_HOST=/m.test(envContent)) envContent += `\nDB_HOST=${data.dbHost}`;
        if (!/^DB_PORT=/m.test(envContent)) envContent += `\nDB_PORT=${data.dbPort}`;
        if (!/^DB_DATABASE=/m.test(envContent)) envContent += `\nDB_DATABASE=${data.dbName}`;
        if (!/^DB_USERNAME=/m.test(envContent)) envContent += `\nDB_USERNAME=${data.dbUsername}`;
        if (!/^DB_PASSWORD=/m.test(envContent)) envContent += `\nDB_PASSWORD=${data.dbPassword}`;

        fs.writeFileSync(envPath, envContent, 'utf8');
    }

    _getHtmlForWebview() {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Create Laravel Project</title>
            <style>
                body {
                    padding: 20px;
                    font-family: var(--vscode-font-family);
                    color: var(--vscode-foreground);
                    background-color: var(--vscode-editor-background);
                    max-width: 600px;
                    margin: 0 auto;
                }
                .form-group {
                    margin-bottom: 15px;
                }
                label {
                    display: block;
                    margin-bottom: 5px;
                    font-weight: 600;
                }
                input {
                    width: 100%;
                    padding: 8px;
                    border: 1px solid var(--vscode-input-border);
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border-radius: 4px;
                    box-sizing: border-box;
                }
                input:focus {
                    outline: 1px solid var(--vscode-focusBorder);
                }
                button {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 10px 15px;
                    cursor: pointer;
                    font-size: 14px;
                    border-radius: 4px;
                    width: 100%;
                    margin-top: 10px;
                }
                button:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                button:disabled {
                    background-color: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                    cursor: not-allowed;
                }
                #status {
                    margin-top: 20px;
                    padding: 10px;
                    border-radius: 4px;
                    display: none;
                }
                .success { background-color: rgba(0, 255, 0, 0.1); border: 1px solid green; color: green; }
                .error { background-color: rgba(255, 0, 0, 0.1); border: 1px solid red; color: red; }
                .progress { background-color: rgba(0, 0, 255, 0.1); border: 1px solid var(--vscode-focusBorder); color: var(--vscode-foreground); }
                
                #consoleArea {
                    margin-top: 20px;
                    width: 100%;
                    height: 150px;
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                    border: 1px solid var(--vscode-input-border);
                    font-family: monospace;
                    font-size: 12px;
                    overflow-y: scroll;
                    padding: 10px;
                    box-sizing: border-box;
                    white-space: pre-wrap;
                    display: none;
                }
                .title {
                    font-size: 20px;
                    font-weight: bold;
                    margin-bottom: 20px;
                    text-align: center;
                }
            </style>
        </head>
        <body>
            <div class="title">Create a new Laravel Project</div>
            
            <div class="form-group">
                <label for="projectName">Project Name</label>
                <input type="text" id="projectName" placeholder="my-laravel-app" required>
            </div>
            <div class="form-group">
                <label for="dbHost">Database Host</label>
                <input type="text" id="dbHost" value="127.0.0.1" required>
            </div>
            <div class="form-group">
                <label for="dbPort">Database Port</label>
                <input type="text" id="dbPort" value="3306" required>
            </div>
            <div class="form-group">
                <label for="dbName">Database Name</label>
                <input type="text" id="dbName" placeholder="laravel_db" required>
            </div>
            <div class="form-group">
                <label for="dbUsername">Database Username</label>
                <input type="text" id="dbUsername" placeholder="root" required>
            </div>
            <div class="form-group">
                <label for="dbPassword">Database Password</label>
                <input type="password" id="dbPassword" placeholder="secret">
            </div>

            <button id="submitBtn">Create Laravel Project</button>

            <div id="status"></div>
            <div id="consoleArea"></div>

            <script>
                const vscode = acquireVsCodeApi();
                
                const submitBtn = document.getElementById('submitBtn');
                const statusDiv = document.getElementById('status');
                const consoleArea = document.getElementById('consoleArea');

                submitBtn.addEventListener('click', () => {
                    const projectName = document.getElementById('projectName').value;
                    const dbHost = document.getElementById('dbHost').value;
                    const dbPort = document.getElementById('dbPort').value;
                    const dbName = document.getElementById('dbName').value;
                    const dbUsername = document.getElementById('dbUsername').value;
                    const dbPassword = document.getElementById('dbPassword').value;

                    if (!projectName) {
                        showStatus('error', 'Project Name is required');
                        return;
                    }

                    // Reset UI
                    consoleArea.innerHTML = '';
                    consoleArea.style.display = 'block';
                    showStatus('progress', 'Starting execution...');
                    submitBtn.disabled = true;

                    vscode.postMessage({
                        type: 'createProject',
                        data: {
                            projectName,
                            dbHost,
                            dbPort,
                            dbName,
                            dbUsername,
                            dbPassword
                        }
                    });
                });

                window.addEventListener('message', event => {
                    const message = event.data;
                    switch (message.type) {
                        case 'error':
                            showStatus('error', message.message);
                            submitBtn.disabled = false;
                            break;
                        case 'success':
                            showStatus('success', message.message);
                            submitBtn.disabled = false;
                            break;
                        case 'progress':
                            showStatus('progress', message.message);
                            break;
                        case 'log':
                            consoleArea.innerHTML += message.message;
                            consoleArea.scrollTop = consoleArea.scrollHeight;  // Auto-scroll
                            break;
                    }
                });

                function showStatus(type, text) {
                    statusDiv.style.display = 'block';
                    statusDiv.className = type;
                    statusDiv.innerText = text;
                }
            </script>
        </body>
        </html>`;
    }
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
}
