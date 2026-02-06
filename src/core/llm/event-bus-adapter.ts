import { EventEmitter } from 'events';

export type EventBusHandler<T> = (event: T) => void | Promise<void>;

export interface EventBusAdapter<T> {
    publish(event: T): Promise<void>;
    subscribe(handler: EventBusHandler<T>): () => void;
}

export class InMemoryEventBusAdapter<T> implements EventBusAdapter<T> {
    private readonly emitter = new EventEmitter();
    private readonly topic = 'runtime-event';

    async publish(event: T): Promise<void> {
        this.emitter.emit(this.topic, event);
    }

    subscribe(handler: EventBusHandler<T>): () => void {
        const listener = (event: T) => {
            void handler(event);
        };
        this.emitter.on(this.topic, listener);
        return () => this.emitter.off(this.topic, listener);
    }
}
