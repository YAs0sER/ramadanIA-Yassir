async function speakDarija() {
  const apiKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoiNjlhYzU0ZDI2ODFkY2M4MTUwMjc4MmI3Iiwic2tpbGxfaWQiOiJhcGlfdG9rZW4iLCJpYXQiOjE3NzI5MDE3NzN9.UvzShnsWhSMXjpDfIQ9txd3WVnTae9Znhbm1x4PXNqY";

  const response = await fetch(
    "https://apis.smartly.ai/synthesize/darija-audio/darija_marocaine",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text: "Salam labas? Kidayr?"
      })
    }
  );

  const audioBlob = await response.blob();
  const audioUrl = URL.createObjectURL(audioBlob);

  const audio = new Audio(audioUrl);
  audio.play();
}

speakDarija();