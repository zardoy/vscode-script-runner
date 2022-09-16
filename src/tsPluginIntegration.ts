import { exec } from 'child_process'
import { promisify } from 'util'
import * as vscode from 'vscode'
import { getExtensionSettingId } from 'vscode-framework'
import { Configuration, CustomPluginData } from './configurationType'
import { SCHEME } from './fileSystem'

// that's fine untill..
export let globalNodeModulesRoot: string | undefined | null
export let detectedPackageManager = 'npm'

const execPromise = promisify(exec)

/** Handle plugin's config */
export default async () => {
    // TODO-low i think executing it on every launch could affect performance (but very small)
    if (globalNodeModulesRoot === undefined) {
        let { stdout } = await execPromise('pnpm root -g').catch(() => ({ stdout: undefined }))
        if (!stdout) {
            stdout = (await execPromise('npm root -g').catch(() => ({ stdout: undefined }))).stdout
            if (stdout) detectedPackageManager = 'npm'
        } else {
            detectedPackageManager = 'pnpm'
        }
        globalNodeModulesRoot = stdout ? stdout.toString().trim() : null
    }

    const PLUGIN_NAME = 'vscode-ide-scripting-typescript-plugin'

    const tsExtension = vscode.extensions.getExtension('vscode.typescript-language-features')
    if (!tsExtension) return

    await tsExtension.activate()

    // Get the API from the TS extension
    if (!tsExtension.exports || !tsExtension.exports.getAPI) return

    const api = tsExtension.exports.getAPI(0)
    if (!api) return

    const getTargetEditorsNum = () => vscode.window.visibleTextEditors.filter(({ document: { uri } }) => !['output', SCHEME].includes(uri.scheme)).length
    let targetVisibleEditorsNum = getTargetEditorsNum()

    const syncConfig = () => {
        const config = vscode.workspace.getConfiguration().get(process.env.IDS_PREFIX!) as Configuration & CustomPluginData
        if (!config.vscodeAliases.includes('vscode')) {
            void vscode.window.showErrorMessage(`Settiing ${getExtensionSettingId('vscodeAliases')} is ignored as it must contain vscode alias`)
            config.vscodeAliases = ['vscode']
        }

        config.npmRoot = globalNodeModulesRoot ?? undefined
        config.targetEditorVisible = targetVisibleEditorsNum >= 1
        api.configurePlugin(PLUGIN_NAME, config)
    }

    vscode.workspace.onDidChangeConfiguration(({ affectsConfiguration }) => {
        if (affectsConfiguration(process.env.IDS_PREFIX!)) syncConfig()
    })
    syncConfig()

    vscode.window.onDidChangeVisibleTextEditors(editors => {
        const newNum = getTargetEditorsNum()
        // TODO move it from here
        void vscode.commands.executeCommand(
            'setContext',
            'ideScripting.playgroundEditorVisible',
            editors.some(({ document: { uri } }) => uri.scheme === SCHEME),
        )
        const isChanged = targetVisibleEditorsNum === 0 || newNum === 0
        targetVisibleEditorsNum = newNum
        if (isChanged) syncConfig()
    })

    let tsRestarts = 0

    let firstCheck = true
    const restartTsServer = async () => {
        console.debug('restarting ts server, as plugin received no configuration')
        tsRestarts++
        if (tsRestarts > 2) {
            // avoid spamming
            if (tsRestarts > 3) return
            vscode.window.showErrorMessage("There is a problem with with TypeScript plugin as it can't be configured properly")
            return
        }
        await vscode.commands.executeCommand('typescript.restartTsServer')
        firstCheck = true
        checkPluginNeedsConfig()
    }

    const checkPluginNeedsConfig = async (uri?: vscode.Uri) => {
        if (uri?.scheme !== SCHEME) return
        if (firstCheck) {
            await new Promise(resolve => {
                setTimeout(resolve, 600)
            })
        }
        firstCheck = false
        // console.time('check plugin')
        const { body: result } = (await vscode.commands.executeCommand('typescript.tsserverRequest', 'semanticDiagnosticsSync', {
            _: '%%%',
            file: `^/ideScripting.playground/ts-nul-authority/${uri.path}`,
        })) as any
        // console.timeEnd('check plugin')
        if (result?.find(({ text }) => text === 'no-plugin-configuration')) {
            // plugin not feeling good today, lets help him
            await restartTsServer()
        }
    }

    vscode.window.onDidChangeActiveTextEditor(textEditor => {
        checkPluginNeedsConfig(textEditor?.document.uri)
    })

    checkPluginNeedsConfig(vscode.window.activeTextEditor?.document.uri)
}