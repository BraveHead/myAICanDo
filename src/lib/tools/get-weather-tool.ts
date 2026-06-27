import { tool } from "langchain";
import * as z from "zod";

const getWeatherInputSchema = z.object({
  city: z.string().describe("The city to get the weather for"),
});

export const getWeatherTool = tool(
  ({ city }) => `It's always sunny in ${city}!`,
  {
    name: "get_weather",
    description: "Get the weather for a given city",
    returnDirect: true,
    schema: getWeatherInputSchema,
  },
);
