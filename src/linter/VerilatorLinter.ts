import {
    workspace,
    window,
    Disposable,
    Range,
    TextDocument,
    Diagnostic,
    DiagnosticSeverity,
    DiagnosticCollection,
    languages,
    Uri,
} from 'vscode';
import * as child from 'child_process';
import BaseLinter from './BaseLinter';
import * as path from 'path';
import { Logger, LogSeverity } from '../Logger';
import FileStream from 'antlr4/FileStream';

var isWindows = process.platform === 'win32';

export default class VerilatorLinter extends BaseLinter {
    private verilatorPath: string;
    private verilatorArgs: string;
    private runAtFileLocation: boolean;
    private useWSL: boolean;

    constructor(diagnosticCollection: DiagnosticCollection, logger: Logger) {
        super('verilator', diagnosticCollection, logger);

        workspace.onDidChangeConfiguration(() => {
            this.getConfig();
        });
        this.getConfig();
    }

    private getConfig() {
        this.verilatorPath = <string>(
            workspace
                .getConfiguration()
                .get('verilog.linting.path', '')
        );
        this.verilatorArgs = <string>(
            workspace
                .getConfiguration()
                .get('verilog.linting.verilator.arguments', '')
        );
        this.runAtFileLocation = <boolean>(
            workspace
                .getConfiguration()
                .get('verilog.linting.verilator.runAtFileLocation')
        );
        this.useWSL = <boolean>(
            workspace.getConfiguration().get('verilog.linting.verilator.useWSL')
        );
    }

    protected splitTerms(line: string) {
        let terms = line.split(':');

        for (var i = 0; i < terms.length; i++) {
            if (terms[i] === ' ') {
                terms.splice(i, 1);
                i--;
            } else {
                terms[i] = terms[i].trim();
            }
        }

        return terms;
    }

    protected getSeverity(severityString: string) {
        let result = DiagnosticSeverity.Information;

        if (severityString.startsWith('Error')) {
            result = DiagnosticSeverity.Error;
        } else if (severityString.startsWith('Warning')) {
            result = DiagnosticSeverity.Warning;
        }

        return result;
    }

    protected lint(doc: TextDocument) {
        this.logger.log('verilator lint requested');
        let docUri: string = doc.uri.fsPath; //path of current doc
        let lastIndex: number =
            isWindows
                ? docUri.lastIndexOf('\\')
                : docUri.lastIndexOf('/');
        let docFolder = docUri.substr(0, lastIndex); //folder of current doc
        let runLocation: string =
            this.runAtFileLocation ? docFolder : workspace.rootPath; //choose correct location to run
        let svArgs: string = doc.languageId === 'systemverilog' ? '-sv' : ''; //Systemverilog args
        let verilator: string = 'verilator';
        if (isWindows) {
            if (this.useWSL) {
                verilator = `wsl ${verilator}`;
                let docUriCmd: string = `wsl wslpath '${docUri}'`;
                docUri = child
                    .execSync(docUriCmd, {})
                    .toString()
                    .replace(/\r?\n/g, '');
                this.logger.log(
                    `Rewrote docUri to ${docUri} for WSL`,
                    LogSeverity.info
                );

                let docFolderCmd: string = `wsl wslpath '${docFolder}'`;
                docFolder = child
                    .execSync(docFolderCmd, {})
                    .toString()
                    .replace(/\r?\n/g, '');
                this.logger.log(
                    `Rewrote docFolder to ${docFolder} for WSL`,
                    LogSeverity.info
                );
            } else {
                verilator = verilator + '_bin.exe';
                docUri = docUri.replace(/\\/g, '/');
                docFolder = docFolder.replace(/\\/g, '/');
            }
        }
        const command = [
            path.join(this.verilatorPath, verilator),
            svArgs,
            '--lint-only',
            '-I'+ docFolder,
            this.verilatorArgs,
            docUri,
        ].join(' '); //command to execute
        this.logger.log(command, LogSeverity.command);

        var foo: child.ChildProcess = child.exec(
            command,
            { cwd: runLocation },
            (error: Error, _stdout: string, stderr: string) => {
                if (error) {
                    this.logger.log(error.message, LogSeverity.error);
                }

                interface Diagnostics {
                    [filename: string]: Diagnostic[]
                };
                const diagnostics: Diagnostics = {};
                let lines = stderr.split(/\r?\n/g);

                // Parse output lines
                lines.forEach((line, _) => {
                    // Error for our file
                    const re = new RegExp(/%(\w+)(-[A-Z0-9_]+)?:\s*(.*\.[a-zA-Z]+):(\d+):(?:\s*(\d+):)?\s*(\s*.+)/);
                    if (line.search(re) !== -1) {
                        let rex = line.match(re);

                        if (rex && rex[0].length > 0) {
                            let severity = this.getSeverity(rex[1]);
                            let code = rex[2] !== undefined ? rex[2].slice(1) : 'verilator';
                            //let filename = this.runAtFileLocation ? rex[3] : path.join(workspace.rootPath, rex[3]);
                            let filename = this.runAtFileLocation ? rex[3] : path.isAbsolute(rex[3]) ? rex[3] : path.join(workspace.rootPath, rex[3]);
                            let lineNum = Number(rex[4]) - 1;
                            let colNum = Number(rex[5]) - 1;
                            let message = rex[6];
                            // Type of warning is in rex[2]
                            colNum = isNaN(colNum) ? 0 : colNum; // for older Verilator versions (< 4.030 ~ish)
                            
                            if (!isNaN(lineNum)) {
                                console.log(
                                    severity + ': [' + lineNum + '] ' + message
                                );

                                const diagnostic: Diagnostic = {
                                    severity: severity,
                                    range: new Range(
                                        lineNum,
                                        colNum,
                                        lineNum,
                                        Number.MAX_VALUE
                                    ),
                                    message: message,
                                    code: code,
                                    source: 'verilator',
                                };

                                if (Object.keys(diagnostics).indexOf(filename) === -1) {
                                    diagnostics[filename] = [diagnostic];
                                } else {
                                    diagnostics[filename].push(diagnostic);
                                }
                                console.log(filename);
                            }
                        } else {
                            this.logger.log(
                                'failed to parse error: ' + line,
                                LogSeverity.warn
                            );
                        }
                    }
                });
                this.diagnosticCollection.clear();
                this.logger.log(
                    diagnostics.length + ' errors/warnings returned'
                );
                for(const filename in diagnostics) {
                    this.diagnosticCollection.set(Uri.file(filename), diagnostics[filename]);
                }
            }
        );
    }
}
