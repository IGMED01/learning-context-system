# Learning Context System - Resumen en espanol

Learning Context System es una CLI experimental para **programar, ensenar y controlar contexto al mismo tiempo**.

## Que hace este proyecto

Este repo hace tres cosas juntas:

1. **selecciona contexto util**
2. **explica el codigo y el cambio**
3. **recuerda decisiones duraderas**

La idea central es simple:

- no mandar todo al modelo
- filtrar ruido antes de construir el contexto
- ensenar sobre el codigo mientras se trabaja
- mantener la memoria de largo plazo separada del contexto inmediato

## Que problema intenta resolver

Cuando un asistente de codigo recibe demasiado material:

- entra ruido
- se mezclan logs, chat y documentacion irrelevante
- baja la calidad de la respuesta
- se pierde valor pedagogico

Este proyecto intenta resolver eso con tres capas:

1. **selector de contexto**: decide que merece entrar
2. **capa pedagogica**: ordena el material para ensenar
3. **memoria durable**: recupera decisiones utiles de sesiones anteriores

## Que usamos de Engram y para que

Usamos **[Engram](https://github.com/Gentleman-Programming/engram)** de Gentleman-Programming **unicamente para la capa de memoria durable**.

En este repo, Engram se usa solo para:

- guardar memorias importantes del proyecto
- recuperar decisiones y resumenes previos
- separar la memoria historica del contexto actual

Engram **no** se usa aqui para:

- generar codigo
- rankear chunks del selector
- construir la parte pedagogica
- reemplazar la logica principal de la CLI

## Que no es este proyecto

No es todavia:

- un framework maduro
- una plataforma multiagente cerrada
- un producto terminado

Si es hoy:

- un prototipo serio
- una herramienta local usable
- un experimento medible con benchmarks

## Mapa rapido del repo

- `README.md`: overview en ingles
- `README.es.md`: resumen explicito en espanol
- `AGENTS.md`: contrato operativo del proyecto
- `docs/repo-analysis.md`: por que se eligio Engram como referencia principal
- `docs/context-noise-cancellation.md`: diseno del filtro de contexto
- `docs/usage.md`: como usar la CLI
- `src/context/noise-canceler.js`: selector de contexto
- `src/learning/mentor-loop.js`: paquete pedagogico
- `src/memory/engram-client.js`: adaptador local a Engram
- `examples/typescript-backend/`: vertical real de TypeScript backend

## Demo principal hoy

La demo mas fuerte hoy es el vertical de middleware TypeScript:

```bash
npm run vertical:ts:teach
npm run vertical:ts:seed-memory
npm run vertical:ts:teach:memory
```

## Estado real

Estado actual:

- el proyecto ya funciona
- ya tiene benchmarks
- ya tiene CI
- ya tiene un vertical real

Pero todavia le falta:

- mas dureza en algunos casos reales
- mas polish en documentacion y ergonomia
- mas validacion antes de venderlo como framework serio
