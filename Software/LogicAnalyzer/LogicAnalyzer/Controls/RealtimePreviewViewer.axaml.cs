using Avalonia;
using Avalonia.Controls;
using Avalonia.Media;
using LogicAnalyzer.Classes;
using SharedDriver;
using System;
using System.Collections.Generic;

namespace LogicAnalyzer.Controls
{
    public partial class RealtimePreviewViewer : UserControl
    {
        const int LABEL_WIDTH = 120;
        const int LED_ROW_HEIGHT = 30;
        const int MIN_CHANNEL_HEIGHT = 32;

        private int maxSamples = 10000;
        private AnalyzerChannel[]? channels;
        private List<byte[]> sampleBuffer = new List<byte[]>(); // each entry is byte[channelCount], one per sample

        public RealtimePreviewViewer()
        {
            InitializeComponent();
        }

        public void Initialize(AnalyzerChannel[] previewChannels, int maxDisplaySamples = 10000)
        {
            channels = previewChannels;
            maxSamples = Math.Max(100, maxDisplaySamples);
            sampleBuffer.Clear();
            InvalidateVisual();
        }

        public void AddSamples(byte[][] samples)
        {
            if (channels == null) return;

            for (int s = 0; s < samples.Length; s++)
            {
                byte[] sample = new byte[channels.Length];
                for (int ch = 0; ch < channels.Length && ch < samples[s].Length; ch++)
                    sample[ch] = samples[s][ch];
                sampleBuffer.Add(sample);
            }

            // Trim to max
            while (sampleBuffer.Count > maxSamples)
                sampleBuffer.RemoveAt(0);

            InvalidateVisual();
        }

        public override void Render(DrawingContext context)
        {
            base.Render(context);

            if (channels == null || channels.Length == 0)
                return;

            Rect thisBounds = new Rect(0, 0, Bounds.Width, Bounds.Height);
            context.FillRectangle(GraphicObjectsCache.GetBrush(Color.Parse("#383838")), thisBounds);
            using (context.PushClip(thisBounds))
            {
                int channelCount = channels.Length;
                double ledRowTotalHeight = LED_ROW_HEIGHT;
                double waveformTop = ledRowTotalHeight + 4;
                double waveformHeight = thisBounds.Height - waveformTop;

                if (waveformHeight < channelCount * 10)
                    waveformHeight = channelCount * 10;

                double channelHeight = waveformHeight / channelCount;

                // Draw LED state indicators
                DrawLedRow(context, thisBounds.Width, channelCount);

                // Draw separator line
                context.DrawLine(
                    GraphicObjectsCache.GetPen(Colors.Gray, 1),
                    new Point(0, ledRowTotalHeight + 2),
                    new Point(thisBounds.Width, ledRowTotalHeight + 2));

                // Draw waveform area
                DrawWaveform(context, waveformTop, waveformHeight, thisBounds.Width, channelCount, channelHeight);

                // Draw "Waiting for data..." if no samples received yet
                if (sampleBuffer.Count == 0)
                {
                    var waitText = new FormattedText("Waiting for data...", System.Globalization.CultureInfo.CurrentCulture,
                        FlowDirection.LeftToRight,
                        new Typeface("Arial", FontStyle.Normal, FontWeight.Normal),
                        16, GraphicObjectsCache.GetBrush(Colors.Gray));

                    double textX = (thisBounds.Width - waitText.Width) / 2;
                    double textY = waveformTop + (waveformHeight - waitText.Height) / 2;
                    context.DrawText(waitText, new Point(textX, textY));
                }
            }
        }

        private void DrawLedRow(DrawingContext context, double totalWidth, int channelCount)
        {
            double ledSize = 16;
            double spacing = 8;
            double x = LABEL_WIDTH;

            for (int ch = 0; ch < channelCount; ch++)
            {
                var color = AnalyzerColors.GetChannelColor(channels![ch]);
                string label = string.IsNullOrWhiteSpace(channels[ch].ChannelName)
                    ? $"Ch{channels[ch].ChannelNumber + 1}"
                    : channels[ch].ChannelName;

                // Determine current state from last sample
                bool isHigh = false;
                if (sampleBuffer.Count > 0)
                {
                    var lastSample = sampleBuffer[sampleBuffer.Count - 1];
                    if (ch < lastSample.Length)
                        isHigh = lastSample[ch] != 0;
                }

                // Draw LED rectangle
                var ledColor = isHigh ? Color.FromRgb(0, 200, 0) : Color.FromRgb(80, 80, 80);
                context.FillRectangle(
                    GraphicObjectsCache.GetBrush(ledColor),
                    new Rect(x, 4, ledSize, ledSize));

                // Draw channel label next to LED
                var text = new FormattedText(label, System.Globalization.CultureInfo.CurrentCulture,
                    FlowDirection.LeftToRight,
                    new Typeface("Arial", FontStyle.Normal, FontWeight.Normal),
                    11, GraphicObjectsCache.GetBrush(color));

                context.DrawText(text, new Point(x + ledSize + 3, 4));

                x += ledSize + text.Width + spacing + 6;

                if (x > totalWidth - 20)
                    break;
            }
        }

        private void DrawWaveform(DrawingContext context, double top, double height, double totalWidth, int channelCount, double channelHeight)
        {
            double waveformWidth = totalWidth - LABEL_WIDTH;

            if (waveformWidth <= 0 || sampleBuffer.Count == 0)
            {
                // Draw channel labels even with no data
                for (int ch = 0; ch < channelCount; ch++)
                {
                    double yBase = top + ch * channelHeight;
                    context.FillRectangle(
                        GraphicObjectsCache.GetBrush(AnalyzerColors.BgChannelColors[ch % 2]),
                        new Rect(0, yBase, totalWidth, channelHeight));

                    DrawChannelLabel(context, ch, yBase, channelHeight);
                }
                return;
            }

            int sampleCount = sampleBuffer.Count;
            double sampleWidth = waveformWidth / Math.Max(sampleCount, 1);

            // If we have many samples, limit the pixel width
            if (sampleWidth < 1)
                sampleWidth = 1;

            int visibleSamples = Math.Min(sampleCount, (int)(waveformWidth / sampleWidth));
            int startSample = sampleCount - visibleSamples;

            double margin = channelHeight * 0.15;

            for (int ch = 0; ch < channelCount; ch++)
            {
                double yBase = top + ch * channelHeight;
                double yHi = yBase + margin;
                double yLo = yBase + channelHeight - margin;

                // Background
                context.FillRectangle(
                    GraphicObjectsCache.GetBrush(AnalyzerColors.BgChannelColors[ch % 2]),
                    new Rect(0, yBase, totalWidth, channelHeight));

                // Channel label
                DrawChannelLabel(context, ch, yBase, channelHeight);

                // Draw waveform
                var channelColor = AnalyzerColors.GetChannelColor(channels![ch]);
                var pen = GraphicObjectsCache.GetPen(channelColor, 1.5);

                for (int s = startSample; s < sampleCount; s++)
                {
                    int idx = s - startSample;
                    double x = LABEL_WIDTH + idx * sampleWidth;

                    byte val = ch < sampleBuffer[s].Length ? sampleBuffer[s][ch] : (byte)0;
                    double y = val != 0 ? yHi : yLo;

                    // Draw horizontal line for this sample
                    context.DrawLine(pen, new Point(x, y), new Point(x + sampleWidth, y));

                    // Draw transition line if value changed from previous
                    if (s > startSample)
                    {
                        byte prevVal = ch < sampleBuffer[s - 1].Length ? sampleBuffer[s - 1][ch] : (byte)0;
                        if (prevVal != val)
                        {
                            double prevY = prevVal != 0 ? yHi : yLo;
                            context.DrawLine(pen, new Point(x, prevY), new Point(x, y));
                        }
                    }
                }
            }
        }

        private void DrawChannelLabel(DrawingContext context, int ch, double yBase, double channelHeight)
        {
            var color = AnalyzerColors.GetChannelColor(channels![ch]);
            string label = string.IsNullOrWhiteSpace(channels[ch].ChannelName)
                ? $"Channel {channels[ch].ChannelNumber + 1}"
                : channels[ch].ChannelName;

            var text = new FormattedText(label, System.Globalization.CultureInfo.CurrentCulture,
                FlowDirection.LeftToRight,
                new Typeface("Arial", FontStyle.Normal, FontWeight.Normal),
                12, GraphicObjectsCache.GetBrush(color));

            double textY = yBase + (channelHeight - text.Height) / 2;
            context.DrawText(text, new Point(5, textY));
        }
    }
}
