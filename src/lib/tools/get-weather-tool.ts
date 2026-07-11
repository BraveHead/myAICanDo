import { tool } from "langchain";
import * as z from "zod";
import { getWeatherForCity } from "@/lib/agent/services/weather-service";

const getWeatherInputSchema = z.object({
  city: z.string().describe("The city to get the weather for"),
});

export const getWeatherTool = tool(
  ({ city }) => {
    const result = getWeatherForCity(city);
    return result.ok ? result.content : result.summary;
  },
  {
    name: "get_weather",
    description: "Get the weather for a given city",
    returnDirect: true,
    schema: getWeatherInputSchema,
  },
);
