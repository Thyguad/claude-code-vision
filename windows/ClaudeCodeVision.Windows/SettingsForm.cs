using System.Text.Json;
using System.Text.Json.Nodes;

namespace ClaudeCodeVision.Windows;

internal sealed class SettingsForm : Form
{
    private readonly string configPath;
    private readonly ComboBox provider = new() { DropDownStyle = ComboBoxStyle.DropDownList };
    private readonly TextBox baseUrl = new();
    private readonly TextBox apiKey = new() { UseSystemPasswordChar = true };
    private readonly TextBox model = new();
    private readonly TextBox prompt = new() { Multiline = true, ScrollBars = ScrollBars.Vertical };

    public SettingsForm(string configPath)
    {
        this.configPath = configPath;
        Text = "识图模型设置";
        Width = 560;
        Height = 390;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;

        provider.Items.AddRange(["gemini", "openai-compatible"]);
        var table = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(16), ColumnCount = 2, RowCount = 6 };
        table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 100));
        table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        AddRow(table, "供应商", provider, 0);
        AddRow(table, "接口地址", baseUrl, 1);
        AddRow(table, "API Key", apiKey, 2);
        AddRow(table, "模型", model, 3);
        AddRow(table, "提示词", prompt, 4);
        table.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        var save = new Button { Text = "保存", Anchor = AnchorStyles.Right, Width = 90 };
        save.Click += (_, _) => SaveAndClose();
        table.Controls.Add(save, 1, 5);
        Controls.Add(table);
        LoadConfig();
    }

    private static void AddRow(TableLayoutPanel table, string label, Control control, int row)
    {
        control.Dock = DockStyle.Fill;
        table.Controls.Add(new Label { Text = label, AutoSize = true, Anchor = AnchorStyles.Left }, 0, row);
        table.Controls.Add(control, 1, row);
    }

    private void LoadConfig()
    {
        JsonNode? config = null;
        try { config = JsonNode.Parse(File.ReadAllText(configPath)); } catch { }
        provider.SelectedItem = config?["provider"]?.GetValue<string>() ?? "gemini";
        baseUrl.Text = config?["baseUrl"]?.GetValue<string>() ?? "";
        apiKey.Text = config?["apiKey"]?.GetValue<string>() ?? "";
        model.Text = config?["model"]?.GetValue<string>() ?? "gemini-2.5-flash";
        prompt.Text = config?["prompt"]?.GetValue<string>() ?? "";
    }

    private void SaveAndClose()
    {
        var value = new { provider = provider.SelectedItem?.ToString() ?? "gemini", baseUrl = baseUrl.Text.Trim(), apiKey = apiKey.Text.Trim(), model = model.Text.Trim(), prompt = prompt.Text.Trim() };
        Directory.CreateDirectory(Path.GetDirectoryName(configPath)!);
        var temporary = configPath + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(value, new JsonSerializerOptions { WriteIndented = true }));
        File.Move(temporary, configPath, true);
        DialogResult = DialogResult.OK;
        Close();
    }
}
