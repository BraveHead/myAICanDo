export type WeatherServiceResult =
  | {
      city: string;
      content: string;
      ok: true;
      summary: string;
    }
  | {
      error: {
        code: string;
        message: string;
      };
      ok: false;
      summary: string;
    };

export function getWeatherForCity(city: string): WeatherServiceResult {
  const normalizedCity = city.trim();
  if (!normalizedCity) {
    return {
      ok: false,
      summary: "Weather error: invalid_city, City cannot be empty.",
      error: {
        code: "invalid_city",
        message: "City cannot be empty.",
      },
    };
  }

  const content = `It's always sunny in ${normalizedCity}!`;
  return {
    ok: true,
    city: normalizedCity,
    content,
    summary: `天气查询结果：${content}`,
  };
}
