using Avalonia;
using Avalonia.Controls;
using Avalonia.Interactivity;
using Avalonia.Media;
using LogicAnalyzer.Classes;
using LogicAnalyzer.Controls;
using LogicAnalyzer.Extensions;
using SharedDriver;
using System;
using System.Collections.Generic;
using System.Linq;

namespace LogicAnalyzer.Dialogs
{
    public partial class PreviewDialog : Window
    {
        ChannelSelector[] captureChannels = [];
        AnalyzerDriverBase driver = null!;

        public PreviewSettings? SelectedSettings { get; private set; }

        public PreviewDialog()
        {
            InitializeComponent();
            btnAccept.Click += BtnAccept_Click;
            btnCancel.Click += BtnCancel_Click;
        }

        public void Initialize(AnalyzerDriverBase Driver, PreviewSettings? previousSettings = null)
        {
            driver = Driver;
            InitializeControlArrays(driver.ChannelCount);

            if (previousSettings != null)
                RestoreSettings(previousSettings);
        }

        private void RestoreSettings(PreviewSettings settings)
        {
            nudProbingFrequency.Value = settings.ProbingFrequency;
            nudMaxSamples.Value = settings.MaxDisplaySamples;

            foreach (var ch in settings.Channels)
            {
                if (ch.ChannelNumber >= 0 && ch.ChannelNumber < captureChannels.Length)
                {
                    var sel = captureChannels[ch.ChannelNumber];
                    sel.Enabled = true;
                    if (!string.IsNullOrWhiteSpace(ch.ChannelName))
                        sel.ChannelName = ch.ChannelName;
                    if (ch.ChannelColor != null)
                        sel.ChannelColor = ch.ChannelColor;
                }
            }
        }

        private void InitializeControlArrays(int ChannelCount)
        {
            List<ChannelSelector> channels = new List<ChannelSelector>();

            for (int firstChan = 0; firstChan < ChannelCount; firstChan += 8)
                pnlChannels.Children.Add(CreateChannelRow(firstChan, channels, ChannelCount));

            captureChannels = channels.ToArray();
        }

        private StackPanel CreateChannelRow(int FirstChannel, List<ChannelSelector> Selectors, int TotalChannels)
        {
            StackPanel panel = new StackPanel();
            panel.Orientation = Avalonia.Layout.Orientation.Horizontal;
            panel.HorizontalAlignment = Avalonia.Layout.HorizontalAlignment.Center;

            Grid grdSel = new Grid();
            grdSel.RowDefinitions = new RowDefinitions("*,*,*");

            var font = FontFamily.Parse("avares://LogicAnalyzer/Assets/Fonts#Font Awesome 6 Free");

            Button btnSelAll = new Button { FontFamily = font, Content = "\uf14a", FontSize = 16 };
            btnSelAll.SetValue(Grid.RowProperty, 0);
            btnSelAll.Click += (s, e) => { foreach (var ch in captureChannels.Where(c => c.ChannelNumber >= FirstChannel && c.ChannelNumber < FirstChannel + 8 && c.IsEnabled)) ch.Enabled = true; };
            btnSelAll.Margin = new Thickness(0);
            btnSelAll.Padding = new Thickness(0);
            btnSelAll.VerticalAlignment = Avalonia.Layout.VerticalAlignment.Stretch;
            btnSelAll.HorizontalAlignment = Avalonia.Layout.HorizontalAlignment.Stretch;
            btnSelAll.HorizontalContentAlignment = Avalonia.Layout.HorizontalAlignment.Center;
            btnSelAll.VerticalContentAlignment = Avalonia.Layout.VerticalAlignment.Center;

            Button btnSelNone = new Button { FontFamily = font, Content = "\uf0c8", FontSize = 16 };
            btnSelNone.SetValue(Grid.RowProperty, 1);
            btnSelNone.Click += (s, e) => { foreach (var ch in captureChannels.Where(c => c.ChannelNumber >= FirstChannel && c.ChannelNumber < FirstChannel + 8 && c.IsEnabled)) ch.Enabled = false; };
            btnSelNone.Margin = new Thickness(0);
            btnSelNone.Padding = new Thickness(5, 0, 5, 0);
            btnSelNone.VerticalAlignment = Avalonia.Layout.VerticalAlignment.Stretch;
            btnSelNone.HorizontalAlignment = Avalonia.Layout.HorizontalAlignment.Stretch;
            btnSelNone.HorizontalContentAlignment = Avalonia.Layout.HorizontalAlignment.Center;
            btnSelNone.VerticalContentAlignment = Avalonia.Layout.VerticalAlignment.Center;

            Button btnSelInv = new Button { FontFamily = font, Content = "\uf362", FontSize = 16 };
            btnSelInv.SetValue(Grid.RowProperty, 2);
            btnSelInv.Click += (s, e) => { foreach (var ch in captureChannels.Where(c => c.ChannelNumber >= FirstChannel && c.ChannelNumber < FirstChannel + 8 && c.IsEnabled)) ch.Enabled = !ch.Enabled; };
            btnSelInv.Margin = new Thickness(0);
            btnSelInv.Padding = new Thickness(0);
            btnSelInv.VerticalAlignment = Avalonia.Layout.VerticalAlignment.Stretch;
            btnSelInv.HorizontalAlignment = Avalonia.Layout.HorizontalAlignment.Stretch;
            btnSelInv.HorizontalContentAlignment = Avalonia.Layout.HorizontalAlignment.Center;
            btnSelInv.VerticalContentAlignment = Avalonia.Layout.VerticalAlignment.Center;

            grdSel.Children.Add(btnSelAll);
            grdSel.Children.Add(btnSelNone);
            grdSel.Children.Add(btnSelInv);

            Border brdSel = new Border();
            brdSel.BorderThickness = new Thickness(1);
            brdSel.BorderBrush = GraphicObjectsCache.GetBrush(Colors.White);
            brdSel.Margin = new Thickness(0);
            brdSel.Padding = new Thickness(0);
            brdSel.CornerRadius = new CornerRadius(0);
            brdSel.HorizontalAlignment = Avalonia.Layout.HorizontalAlignment.Stretch;
            brdSel.VerticalAlignment = Avalonia.Layout.VerticalAlignment.Stretch;

            brdSel.Child = grdSel;

            panel.Children.Add(brdSel);

            for (int buc = 0; buc < 8; buc++)
            {
                var channel = new ChannelSelector { ChannelNumber = (byte)(FirstChannel + buc) };
                panel.Children.Add(channel);
                Selectors.Add(channel);

                if (FirstChannel + buc >= TotalChannels)
                    channel.IsEnabled = false;
            }

            return panel;
        }

        protected override void OnOpened(EventArgs e)
        {
            base.OnOpened(e);
            this.FixStartupPosition();
        }

        private async void BtnAccept_Click(object? sender, RoutedEventArgs e)
        {
            List<AnalyzerChannel> channelsToCapture = new List<AnalyzerChannel>();

            for (int buc = 0; buc < captureChannels.Length; buc++)
            {
                if (captureChannels[buc].Enabled)
                    channelsToCapture.Add(new AnalyzerChannel
                    {
                        ChannelName = captureChannels[buc].ChannelName,
                        ChannelNumber = buc,
                        ChannelColor = captureChannels[buc].ChannelColor
                    });
            }

            if (channelsToCapture.Count == 0)
            {
                await this.ShowError("Error", "Select at least one channel to monitor.");
                return;
            }

            int totalSamplesPerSec = (int)(nudProbingFrequency.Value ?? 120);

            if (totalSamplesPerSec < 1)
            {
                await this.ShowError("Error", "Probing frequency must be at least 1 sample/sec.");
                return;
            }

            // Compute intervals and samples per interval
            // Try to keep samplesPerInterval low (1-16) and intervalsPerSecond reasonable
            int samplesPerInterval;
            int intervalsPerSecond;

            if (totalSamplesPerSec <= 60)
            {
                samplesPerInterval = 1;
                intervalsPerSecond = totalSamplesPerSec;
            }
            else
            {
                // Find a good split: try samplesPerInterval from 1 to 16
                samplesPerInterval = 1;
                intervalsPerSecond = totalSamplesPerSec;

                for (int spi = 16; spi >= 1; spi--)
                {
                    if (totalSamplesPerSec % spi == 0)
                    {
                        int ips = totalSamplesPerSec / spi;
                        if (ips <= 60)
                        {
                            samplesPerInterval = spi;
                            intervalsPerSecond = ips;
                            break;
                        }
                    }
                }

                // If no clean split found, just cap intervalsPerSecond at 60
                if (intervalsPerSecond > 60)
                {
                    intervalsPerSecond = 60;
                    samplesPerInterval = Math.Min(16, (totalSamplesPerSec + intervalsPerSecond - 1) / intervalsPerSecond);
                }
            }

            SelectedSettings = new PreviewSettings
            {
                Channels = channelsToCapture.ToArray(),
                IntervalsPerSecond = intervalsPerSecond,
                SamplesPerInterval = samplesPerInterval,
                ProbingFrequency = totalSamplesPerSec,
                MaxDisplaySamples = (int)(nudMaxSamples.Value ?? 10000)
            };

            this.Close(true);
        }

        private void BtnCancel_Click(object? sender, RoutedEventArgs e)
        {
            this.Close(false);
        }
    }
}
