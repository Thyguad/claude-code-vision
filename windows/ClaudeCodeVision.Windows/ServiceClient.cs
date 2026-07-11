using System.Diagnostics;
using System.Text.Json;

namespace ClaudeCodeVision.Windows;

internal sealed class ServiceClient
{
    private readonly string runtimeDirectory;
    private readonly string nodePath;
    private readonly string cliPath;

    public ServiceClient()
    {
        runtimeDirectory = Path.Combine(AppContext.BaseDirectory, "runtime");
        nodePath = Path.Combine(runtimeDirectory, "node", "node.exe");
        cliPath = Path.Combine(runtimeDirectory, "service", "cli.mjs");
    }

    public string LogPath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude", "vision-proxy.log");
    public string VisionConfigPath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude", "vision-proxy", "vision-model.json");

    public bool IsInstalled => File.Exists(nodePath) && File.Exists(cliPath);

    public async Task<ServiceResult> RunAsync(string command, CancellationToken cancellationToken = default)
    {
        if (!IsInstalled) return new ServiceResult(4, "", $"运行时不完整：{runtimeDirectory}");
        try
        {
            var startInfo = new ProcessStartInfo(nodePath)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = runtimeDirectory,
            };
            startInfo.ArgumentList.Add(cliPath);
            startInfo.ArgumentList.Add(command);
            startInfo.ArgumentList.Add("--json");
            startInfo.Environment["VISION_RUNTIME_DIR"] = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude", "vision-proxy");
            startInfo.Environment["VISION_PROXY_SCRIPT"] = Path.Combine(runtimeDirectory, "proxy.mjs");

            using var process = new Process { StartInfo = startInfo };
            process.Start();
            var outputTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
            var errorTask = process.StandardError.ReadToEndAsync(cancellationToken);
            await process.WaitForExitAsync(cancellationToken);
            return new ServiceResult(process.ExitCode, await outputTask, await errorTask);
        }
        catch (Exception error)
        {
            return new ServiceResult(10, "", error.Message);
        }
    }

    public async Task<bool> IsRunningAsync()
    {
        var result = await RunAsync("status");
        if (string.IsNullOrWhiteSpace(result.Output)) return false;
        try
        {
            using var json = JsonDocument.Parse(result.Output);
            return json.RootElement.TryGetProperty("running", out var running) && running.GetBoolean();
        }
        catch (JsonException) { return false; }
    }
}

internal sealed record ServiceResult(int ExitCode, string Output, string Error)
{
    public bool Success => ExitCode == 0;
}
