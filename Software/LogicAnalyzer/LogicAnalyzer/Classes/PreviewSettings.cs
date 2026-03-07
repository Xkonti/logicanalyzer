using SharedDriver;

namespace LogicAnalyzer.Classes
{
    public class PreviewSettings
    {
        public AnalyzerChannel[] Channels { get; set; } = [];
        public int IntervalsPerSecond { get; set; }
        public int SamplesPerInterval { get; set; }
        public int ProbingFrequency { get; set; } = 120;
        public int MaxDisplaySamples { get; set; } = 10000;
    }
}
