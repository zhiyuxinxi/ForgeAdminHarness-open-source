param(
    [string]$CleanupPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Remove-IntegrationTempDirectory {
    param([Parameter(Mandatory)][string]$Path)

    $resolvedTemp = [IO.Path]::GetFullPath($Path)
    $resolvedBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolvedTemp.StartsWith($resolvedBase, [StringComparison]::OrdinalIgnoreCase) -or
        -not (Split-Path $resolvedTemp -Leaf).StartsWith('forge-file-gateway-it-', [StringComparison]::Ordinal)) {
        throw "Refusing to remove an unexpected integration path: $resolvedTemp"
    }
    if (Test-Path -LiteralPath $resolvedTemp) {
        Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
    }
}

if ($CleanupPath) {
    Remove-IntegrationTempDirectory -Path $CleanupPath
    Write-Host "Removed stale integration directory: $CleanupPath"
    exit 0
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$tempBase = [IO.Path]::GetTempPath()
$tempDir = Join-Path $tempBase ('forge-file-gateway-it-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($tempDir) | Out-Null

$dataDir = Join-Path $tempDir 'data'
$stateDir = Join-Path $tempDir 'state'
$backupDir = Join-Path $tempDir 'backups'
[IO.Directory]::CreateDirectory((Join-Path $dataDir 'project-a')) | Out-Null
[IO.Directory]::CreateDirectory((Join-Path $dataDir 'project-b')) | Out-Null
[IO.Directory]::CreateDirectory($stateDir) | Out-Null
[IO.Directory]::CreateDirectory($backupDir) | Out-Null

$composeProject = 'forge-file-gateway-it-' + [guid]::NewGuid().ToString('N').Substring(0, 12)
$adminPassword = 'it-admin-' + [guid]::NewGuid().ToString('N')
$userPassword = 'it-user-' + [guid]::NewGuid().ToString('N')
$envFile = Join-Path $tempDir 'file-gateway.env'
$composeFile = Join-Path $repoRoot 'templates/file-gateway/compose.yaml'
$image = 'sha256:c728f5d433b5a377d96573002f5dba728d084bea9f831bf0b418e2053a832b78'

$envBody = @(
    "FILE_GATEWAY_COMPOSE_PROJECT_NAME=$composeProject"
    "SFTPGO_RUNTIME_IMAGE=$image"
    'FILE_GATEWAY_BIND_ADDRESS=127.0.0.1'
    'FILE_GATEWAY_HTTP_PORT=24080'
    'FILE_GATEWAY_SFTP_PORT=24022'
    'FILE_GATEWAY_UID=1000'
    'FILE_GATEWAY_GID=1000'
    "FILE_GATEWAY_DATA_ROOT=$($dataDir.Replace('\', '/'))"
    "FILE_GATEWAY_STATE_ROOT=$($stateDir.Replace('\', '/'))"
    "FILE_GATEWAY_BACKUP_ROOT=$($backupDir.Replace('\', '/'))"
    'SFTPGO_DEFAULT_ADMIN_USERNAME=it-admin'
    "SFTPGO_DEFAULT_ADMIN_PASSWORD=$adminPassword"
    'TZ=Asia/Shanghai'
) -join "`n"
[IO.File]::WriteAllText($envFile, "$envBody`n", [Text.UTF8Encoding]::new($false))

try {
    & docker compose --env-file $envFile --file $composeFile up --detach
    if ($LASTEXITCODE -ne 0) {
        throw 'File gateway integration Compose startup failed.'
    }

    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        & docker compose --env-file $envFile --file $composeFile exec -T sftpgo sftpgo ping 2>$null
        if ($LASTEXITCODE -eq 0) {
            $ready = $true
            break
        }
        Start-Sleep -Seconds 2
    }
    if (-not $ready) {
        throw 'SFTPGo did not become ready within 60 seconds.'
    }

    $env:FILE_GATEWAY_ENDPOINT = 'http://127.0.0.1:24080'
    $env:SFTPGO_DEFAULT_ADMIN_USERNAME = 'it-admin'
    $env:SFTPGO_DEFAULT_ADMIN_PASSWORD = $adminPassword
    & python (Join-Path $repoRoot 'scripts/file_gateway_admin.py') sync-group `
        --group forge-all-projects-upload --projects project-a project-b
    if ($LASTEXITCODE -ne 0) {
        throw 'Upload group provisioning failed.'
    }

    $env:FILE_GATEWAY_USER_PASSWORD = $userPassword
    & python (Join-Path $repoRoot 'scripts/file_gateway_admin.py') ensure-user `
        --username it-product --group forge-all-projects-upload --description 'integration test'
    if ($LASTEXITCODE -ne 0) {
        throw 'Upload user provisioning failed.'
    }

    $tokenResponse = & curl.exe -fsS --user "it-product:$userPassword" `
        'http://127.0.0.1:24080/api/v2/user/token'
    if ($LASTEXITCODE -ne 0) {
        throw 'Upload user authentication failed.'
    }
    $token = ($tokenResponse | ConvertFrom-Json).access_token
    if (-not $token) {
        throw 'Upload user token response did not include access_token.'
    }

    $probe = Join-Path $tempDir 'probe.txt'
    [IO.File]::WriteAllText(
        $probe,
        'forge-file-gateway-integration',
        [Text.UTF8Encoding]::new($false)
    )
    & curl.exe -fsS -X POST -H "Authorization: Bearer $token" `
        --data-binary "@$probe" `
        'http://127.0.0.1:24080/api/v2/user/files/upload?path=project-a%2Fprobe.txt'
    if ($LASTEXITCODE -ne 0) {
        throw 'Upload-only user could not upload to an allowed project.'
    }

    $storedProbe = Join-Path $dataDir 'project-a/probe.txt'
    if (-not (Test-Path -LiteralPath $storedProbe -PathType Leaf)) {
        throw 'Uploaded file was not written to the expected host project directory.'
    }
    if ((Get-Content -Raw -LiteralPath $storedProbe) -ne 'forge-file-gateway-integration') {
        throw 'Uploaded file content does not match.'
    }

    $downloadStatus = & curl.exe -sS -o NUL -w '%{http_code}' `
        -H "Authorization: Bearer $token" `
        'http://127.0.0.1:24080/api/v2/user/files?path=project-a%2Fprobe.txt'
    if ($downloadStatus -ne '403') {
        throw "Expected download denial HTTP 403, got $downloadStatus."
    }

    Write-Host 'PASS SFTPGo runtime, group inheritance, upload bind mount and download denial'
}
finally {
    Remove-Item Env:FILE_GATEWAY_ENDPOINT -ErrorAction SilentlyContinue
    Remove-Item Env:SFTPGO_DEFAULT_ADMIN_USERNAME -ErrorAction SilentlyContinue
    Remove-Item Env:SFTPGO_DEFAULT_ADMIN_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:FILE_GATEWAY_USER_PASSWORD -ErrorAction SilentlyContinue

    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & docker compose --env-file $envFile --file $composeFile down 2>&1 | Out-Null
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    Remove-IntegrationTempDirectory -Path $tempDir
}
