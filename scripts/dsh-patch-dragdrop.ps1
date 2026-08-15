# dsh-patch-dragdrop.ps1
# Re-applies the two local compatibility patches for @omdsh-dev/dsh-drag-and-drop
# after `dsh plugin update` overwrites node_modules.
#
# Patch 1: es.exe invocation drops the unsupported `-whole-filename` flag
#          (ES 1.1.0.37 prints usage help instead of results when it sees it).
# Patch 2: Windows search output (es.exe / powershell.exe) is decoded as GBK,
#          fixing Chinese/Unicode path resolution on codepage-936 systems.
#
# Idempotent: safe to run any number of times.
$ErrorActionPreference = "Stop"
$lib = Join-Path $env:USERPROFILE ".dsh\profiles\web\node_modules\@omdsh-dev\dsh-drag-and-drop\lib\index.js"
if (-not (Test-Path $lib)) {
    Write-Host "[ERR] plugin lib not found: $lib"
    exit 1
}
$content = [System.IO.File]::ReadAllText($lib)
$changed = $false

# --- Patch 1: remove -whole-filename flag -----------------------------------
$bad = "`t`t`t`t`"-whole-filename`",`r`n`t`t`t`tname"
if ($content.Contains('"-whole-filename"')) {
    $content = $content.Replace($bad, "`t`t`t`tname")
    if ($content.Contains('"-whole-filename"')) {
        # fallback: strip any standalone occurrence of the flag line
        $content = $content -replace '(?m)^\t*"-whole-filename",\r?\n', ''
    }
    $changed = $true
    Write-Host "[OK] Patch 1 applied (removed -whole-filename)"
} else {
    Write-Host "[SKIP] Patch 1 already applied"
}

# --- Patch 2: GBK decoding of Windows search output --------------------------
if (-not $content.Contains("async execBuffer")) {
    $anchor = "`t},`r`n`tasync windowsDrives() {"
    $inject = "`t},`r`n`tasync execBuffer(command, args) {`r`n`t`tconst { stdout } = await execFileAsync(command, [...args], {`r`n`t`t`ttimeout: COMMAND_TIMEOUT_MS,`r`n`t`t`tmaxBuffer: 1024 * 1024,`r`n`t`t`twindowsHide: true,`r`n`t`t`tencoding: `"buffer`"`r`n`t`t});`r`n`t`treturn stdout;`r`n`t},`r`n`tasync windowsDrives() {"
    if ($content.Contains($anchor)) {
        $content = $content.Replace($anchor, $inject)
        $changed = $true
        Write-Host "[OK] Patch 2a applied (execBuffer helper)"
    } else {
        Write-Host "[ERR] Patch 2a anchor not found - plugin layout changed?"
    }
} else {
    Write-Host "[SKIP] Patch 2a already applied"
}

if ($content.Contains('new TextDecoder("gbk")')) {
    Write-Host "[SKIP] Patch 2b already applied (gbk decode)"
} else {
    # es.exe branch
    $esOld = 'return lines(await runtime.exec(command, ['
    $esNew = 'return lines(new TextDecoder("gbk").decode(await runtime.execBuffer(command, ['
    if ($content.Contains($esOld)) {
        $content = $content.Replace($esOld, $esNew)
        # close the extra paren: `])));` after `name`
        $content = $content.Replace("`t`t`t`tname`r`n`t`t`t])));", "`t`t`t`tname`r`n`t`t`t]))));")
        $changed = $true
        Write-Host "[OK] Patch 2b applied (es.exe gbk)"
    } else {
        Write-Host "[ERR] Patch 2b es.exe anchor not found"
    }
    # powershell fallback branch
    $psOld = 'return lines(await runtime.exec("powershell.exe", ['
    $psNew = 'return lines(new TextDecoder("gbk").decode(await runtime.execBuffer("powershell.exe", ['
    if ($content.Contains($psOld)) {
        $content = $content.Replace($psOld, $psNew)
        $content = $content.Replace("`t`t`t`tscript`r`n`t`t])));", "`t`t`t`tscript`r`n`t`t]))));")
        $changed = $true
        Write-Host "[OK] Patch 2b applied (powershell gbk)"
    } else {
        Write-Host "[ERR] Patch 2b powershell anchor not found"
    }
}

if ($changed) {
    [System.IO.File]::WriteAllText($lib, $content)
    Write-Host "=== patches written to $lib ==="
    Write-Host "NOTE: restart DSH (dsh-restart.ps1) for the running server to load the patched code."
} else {
    Write-Host "=== nothing to do - all patches already in place ==="
}
