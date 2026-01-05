<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http;

use FastRoute\Dispatcher;
use Throwable;

final class Kernel
{
    private Dispatcher $dispatcher;

    private array $prefixMiddlewares;

    public function __construct(Dispatcher $dispatcher, array $prefixMiddlewares)
    {
        $this->dispatcher = $dispatcher;
        $this->prefixMiddlewares = $prefixMiddlewares;
    }

    public function handle(Request $request, Context $context): Response
    {
        try {
            $routeInfo = $this->dispatcher->dispatch($request->method(), $request->path());

            if ($routeInfo[0] === Dispatcher::NOT_FOUND) {
                return JsonResponse::error('not found', 404);
            }

            if ($routeInfo[0] === Dispatcher::METHOD_NOT_ALLOWED) {
                return JsonResponse::error('method not allowed', 405);
            }

            $handler = $routeInfo[1];
            $vars = $routeInfo[2] ?? [];
            if (!is_array($vars)) {
                $vars = [];
            }

            $request = $request->withRouteParams($vars);

            $middlewares = $this->middlewaresForPath($request->path());

            /** @var \Closure(Request, Context): Response $next */
            $next = function (Request $req, Context $ctx) use ($handler): Response {
                return $this->invokeHandler($handler, $req, $ctx);
            };

            for ($i = count($middlewares) - 1; $i >= 0; $i--) {
                $mw = $middlewares[$i] ?? null;
                if (!$mw instanceof Middleware) {
                    continue;
                }

                $prev = $next;
                $next = static function (Request $req, Context $ctx) use ($mw, $prev): Response {
                    return $mw->handle($req, $ctx, $prev);
                };
            }

            return $next($request, $context);
        } catch (HttpError $e) {
            return JsonResponse::error($e->getMessage(), $e->statusCode);
        } catch (Throwable $e) {
            return JsonResponse::error($e->getMessage(), 500, ['type' => get_class($e)]);
        }
    }

    private function invokeHandler(mixed $handler, Request $request, Context $context): Response
    {
        if (is_array($handler) && count($handler) === 2) {
            $class = $handler[0] ?? '';
            $method = $handler[1] ?? '';

            if (!is_string($class) || $class === '' || !is_string($method) || $method === '') {
                throw new HttpError('invalid handler', 500);
            }

            if (!class_exists($class)) {
                throw new HttpError('handler class not found', 500);
            }

            $controller = new $class();
            if (!method_exists($controller, $method)) {
                throw new HttpError('handler method not found', 500);
            }

            $res = $controller->{$method}($request, $context);
            if (!$res instanceof Response) {
                throw new HttpError('handler did not return a Response', 500);
            }

            return $res;
        }

        if (is_callable($handler)) {
            $res = $handler($request, $context);
            if (!$res instanceof Response) {
                throw new HttpError('handler did not return a Response', 500);
            }
            return $res;
        }

        throw new HttpError('invalid handler', 500);
    }

    private function middlewaresForPath(string $path): array
    {
        $prefixes = [];
        foreach ($this->prefixMiddlewares as $prefix => $_) {
            if (is_string($prefix)) {
                $prefixes[] = $prefix;
            }
        }

        usort($prefixes, static function (string $a, string $b): int {
            if ($a === '/' && $b !== '/') {
                return -1;
            }
            if ($b === '/' && $a !== '/') {
                return 1;
            }
            return strlen($a) <=> strlen($b);
        });

        $mws = [];
        foreach ($prefixes as $prefix) {
            $items = $this->prefixMiddlewares[$prefix] ?? null;
            if (!is_array($items)) {
                continue;
            }

            if ($prefix !== '/' && !str_starts_with($path, $prefix)) {
                continue;
            }

            foreach ($items as $mw) {
                if ($mw instanceof Middleware) {
                    $mws[] = $mw;
                }
            }
        }

        return $mws;
    }
}
